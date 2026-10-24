// Package rtc carries everything the peer-to-peer visit needs: a minimal STUN
// server so two panels can discover their public address, an in-memory WebRTC
// signalling exchange, and the last-resort relay used only when hole punching
// fails.
//
// None of it is durable. The Discovery Server stores visit authorisations,
// journal, traces and reputation; room layouts and guest positions never touch
// it. A restart drops every signal and every relay — visits in flight end.
package rtc

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
)

// STUN constants. Only the binding request/response pair is implemented, which
// is all an ICE agent needs to learn its server-reflexive candidate.
const (
	stunMagicCookie = 0x2112A442
	stunHeaderLen   = 20

	stunMethodBinding = 0x001

	stunClassRequest  = 0x0000
	stunClassSuccess  = 0x0100
	stunClassError    = 0x0110
	// Method bits interleave with the class bits; these are the assembled values.
	stunBindingRequest  = stunMethodBinding | stunClassRequest
	stunBindingResponse = stunMethodBinding | stunClassSuccess

	attrMappedAddress    = 0x0001
	attrXORMappedAddress = 0x0020
	attrFingerprint      = 0x8028

	attrHeaderLen = 4
	crc32Polynomial = 0xEDB88320
)

// StunServer answers STUN binding requests over UDP. It is stateless: the only
// thing a client learns from it is the socket address the server sees.
type StunServer struct {
	conn *net.UDPConn
	log  *slog.Logger

	wg     sync.WaitGroup
	closed chan struct{}
	once   sync.Once
}

// Listen opens the STUN socket.
func Listen(addr string, log *slog.Logger) (*StunServer, error) {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("resolve stun address: %w", err)
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return nil, fmt.Errorf("listen stun: %w", err)
	}
	if log == nil {
		log = slog.Default()
	}
	s := &StunServer{conn: conn, log: log, closed: make(chan struct{})}
	s.wg.Add(1)
	go s.serve()
	return s, nil
}

// Close shuts the socket down and waits for the reader to return.
func (s *StunServer) Close() error {
	s.once.Do(func() { close(s.closed) })
	err := s.conn.Close()
	s.wg.Wait()
	return err
}

// Addr reports the listening address, useful for logging after ":0" binding.
func (s *StunServer) Addr() string { return s.conn.LocalAddr().String() }

func (s *StunServer) serve() {
	defer s.wg.Done()
	buf := make([]byte, 1500)
	for {
		select {
		case <-s.closed:
			return
		default:
		}
		n, from, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-s.closed:
				return
			default:
				s.log.Warn("stun read", "error", err)
				continue
			}
		}
		// Copy: the read buffer is reused, and the reply is written from a
		// goroutine-sized piece of work below.
		packet := make([]byte, n)
		copy(packet, buf[:n])
		s.handlePacket(packet, from)
	}
}

func (s *StunServer) handlePacket(packet []byte, from *net.UDPAddr) {
	txID, ok := parseBindingRequest(packet)
	if !ok {
		return
	}
	reply, err := bindingResponse(txID, from)
	if err != nil {
		s.log.Warn("stun response", "error", err)
		return
	}
	if _, err := s.conn.WriteToUDP(reply, from); err != nil {
		s.log.Warn("stun write", "error", err)
	}
}

// parseBindingRequest returns the transaction id of a well-formed binding
// request, and false for anything else. Unknown methods are ignored rather
// than answered, which keeps the server from being useful as a reflector.
func parseBindingRequest(packet []byte) ([12]byte, bool) {
	var txID [12]byte
	if len(packet) < stunHeaderLen {
		return txID, false
	}
	// The top two bits must be zero for any STUN packet.
	if packet[0]&0xC0 != 0 {
		return txID, false
	}
	msgType := binary.BigEndian.Uint16(packet[0:2])
	if msgType != stunBindingRequest {
		return txID, false
	}
	if binary.BigEndian.Uint32(packet[4:8]) != stunMagicCookie {
		return txID, false
	}
	length := int(binary.BigEndian.Uint16(packet[2:4]))
	if length%4 != 0 || stunHeaderLen+length > len(packet) {
		return txID, false
	}
	copy(txID[:], packet[8:20])
	return txID, true
}

// bindingResponse builds a success response carrying both MAPPED-ADDRESS and
// XOR-MAPPED-ADDRESS, so any ICE implementation can read whichever it prefers.
func bindingResponse(txID [12]byte, from *net.UDPAddr) ([]byte, error) {
	ip4 := from.IP.To4()
	if ip4 == nil {
		// IPv6 reflexive candidates are not needed for this deployment; the
		// panel falls back to host candidates.
		return nil, errors.New("stun: not an ipv4 peer")
	}
	port := uint16(from.Port)

	mapped := make([]byte, 8)
	mapped[1] = 0x01 // IPv4 family
	binary.BigEndian.PutUint16(mapped[2:4], port)
	copy(mapped[4:8], ip4)

	xor := make([]byte, 8)
	xor[1] = 0x01
	// The XOR mask is the magic cookie's big-endian bytes.
	cookie := [4]byte{byte(stunMagicCookie >> 24), byte(stunMagicCookie >> 16 & 0xFF), byte(stunMagicCookie >> 8 & 0xFF), byte(stunMagicCookie & 0xFF)}
	xorPort := port ^ binary.BigEndian.Uint16(cookie[0:2])
	binary.BigEndian.PutUint16(xor[2:4], xorPort)
	for i := 0; i < 4; i++ {
		xor[4+i] = ip4[i] ^ cookie[i]
	}

	body := make([]byte, 0, 32)
	body = appendAttribute(body, attrMappedAddress, mapped)
	body = appendAttribute(body, attrXORMappedAddress, xor)
	// FINGERPRINT must come last and covers everything before it.
	body = appendFingerprint(body, txID)

	out := make([]byte, 0, stunHeaderLen+len(body))
	out = binary.BigEndian.AppendUint16(out, stunBindingResponse)
	out = binary.BigEndian.AppendUint16(out, uint16(len(body)))
	out = binary.BigEndian.AppendUint32(out, stunMagicCookie)
	out = append(out, txID[:]...)
	out = append(out, body...)
	return out, nil
}

func appendAttribute(dst []byte, kind uint16, value []byte) []byte {
	dst = binary.BigEndian.AppendUint16(dst, kind)
	dst = binary.BigEndian.AppendUint16(dst, uint16(len(value)))
	dst = append(dst, value...)
	// Attributes are padded to a 4-byte boundary.
	if pad := len(value) % 4; pad != 0 {
		dst = append(dst, make([]byte, 4-pad)...)
	}
	return dst
}

// appendFingerprint appends the FINGERPRINT attribute, computed over the header
// plus every attribute already serialised.
func appendFingerprint(dst []byte, txID [12]byte) []byte {
	head := make([]byte, 0, stunHeaderLen+len(dst))
	head = binary.BigEndian.AppendUint16(head, stunBindingResponse)
	head = binary.BigEndian.AppendUint16(head, uint16(len(dst)+attrHeaderLen+4))
	head = binary.BigEndian.AppendUint32(head, stunMagicCookie)
	head = append(head, txID[:]...)
	head = append(head, dst...)

	crc := crc32Checksum(head) ^ 0x5354554e
	value := make([]byte, 4)
	binary.BigEndian.PutUint32(value, crc)
	return appendAttribute(dst, attrFingerprint, value)
}

func crc32Checksum(data []byte) uint32 {
	var table [256]uint32
	for i := 0; i < 256; i++ {
		c := uint32(i)
		for j := 0; j < 8; j++ {
			if c&1 != 0 {
				c = crc32Polynomial ^ (c >> 1)
			} else {
				c >>= 1
			}
		}
		table[i] = c
	}
	crc := ^uint32(0)
	for _, b := range data {
		crc = table[(crc^uint32(b))&0xFF] ^ (crc >> 8)
	}
	return ^crc
}

// ListenAndServe runs a STUN server until the context is cancelled. It is the
// lifecycle wrapper main() uses.
func ListenAndServe(ctx context.Context, addr string, log *slog.Logger) error {
	srv, err := Listen(addr, log)
	if err != nil {
		return err
	}
	defer srv.Close()
	log.Info("stun listening", "addr", srv.Addr())
	<-ctx.Done()
	return nil
}
