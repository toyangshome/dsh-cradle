package rtc

import (
	"encoding/binary"
	"net"
	"testing"
	"time"
)

// buildBindingRequest assembles a minimal STUN binding request with one
// transaction id, which is all the server requires.
func buildBindingRequest(txID [12]byte) []byte {
	out := make([]byte, 0, 20)
	out = binary.BigEndian.AppendUint16(out, stunBindingRequest)
	out = binary.BigEndian.AppendUint16(out, 0)
	out = binary.BigEndian.AppendUint32(out, stunMagicCookie)
	out = append(out, txID[:]...)
	return out
}

func readAttributes(t *testing.T, body []byte) map[uint16][]byte {
	t.Helper()
	out := map[uint16][]byte{}
	offset := 0
	for offset+attrHeaderLen <= len(body) {
		kind := binary.BigEndian.Uint16(body[offset : offset+2])
		length := int(binary.BigEndian.Uint16(body[offset+2 : offset+4]))
		if offset+attrHeaderLen+length > len(body) {
			t.Fatalf("attribute %#x runs past the body", kind)
		}
		out[kind] = body[offset+attrHeaderLen : offset+attrHeaderLen+length]
		offset += attrHeaderLen + length
		if pad := length % 4; pad != 0 {
			offset += 4 - pad
		}
	}
	return out
}

func TestStunServerAnswersBindingRequest(t *testing.T) {
	srv, err := Listen("127.0.0.1:0", nil)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer srv.Close()

	addr, err := net.ResolveUDPAddr("udp", srv.Addr())
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	client, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	var txID [12]byte
	for i := range txID {
		txID[i] = byte(i + 1)
	}
	if _, err := client.Write(buildBindingRequest(txID)); err != nil {
		t.Fatalf("write: %v", err)
	}

	buf := make([]byte, 1500)
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	packet := buf[:n]

	if len(packet) < stunHeaderLen {
		t.Fatalf("response too short: %d bytes", len(packet))
	}
	if got := binary.BigEndian.Uint16(packet[0:2]); got != stunBindingResponse {
		t.Fatalf("message type = %#x, want %#x", got, stunBindingResponse)
	}
	if got := binary.BigEndian.Uint32(packet[4:8]); got != stunMagicCookie {
		t.Fatalf("magic cookie = %#x, want %#x", got, stunMagicCookie)
	}
	// The transaction id must echo, or the client discards the response.
	for i := 0; i < 12; i++ {
		if packet[8+i] != txID[i] {
			t.Fatalf("transaction id byte %d = %#x, want %#x", i, packet[8+i], txID[i])
		}
	}

	length := int(binary.BigEndian.Uint16(packet[2:4]))
	attrs := readAttributes(t, packet[stunHeaderLen:stunHeaderLen+length])

	mapped, ok := attrs[attrMappedAddress]
	if !ok {
		t.Fatal("MAPPED-ADDRESS missing")
	}
	if len(mapped) < 8 || mapped[1] != 0x01 {
		t.Fatalf("MAPPED-ADDRESS = %x, want an IPv4 address", mapped)
	}
	wantPort := uint16(client.LocalAddr().(*net.UDPAddr).Port)
	if got := binary.BigEndian.Uint16(mapped[2:4]); got != wantPort {
		t.Fatalf("mapped port = %d, want %d", got, wantPort)
	}
	if got := net.IPv4(mapped[4], mapped[5], mapped[6], mapped[7]).String(); got != "127.0.0.1" {
		t.Fatalf("mapped address = %s, want 127.0.0.1", got)
	}

	// XOR-MAPPED-ADDRESS must decode to the same endpoint.
	xor, ok := attrs[attrXORMappedAddress]
	if !ok {
		t.Fatal("XOR-MAPPED-ADDRESS missing")
	}
	if len(xor) < 8 || xor[1] != 0x01 {
		t.Fatalf("XOR-MAPPED-ADDRESS = %x, want an IPv4 address", xor)
	}
	cookie := [4]byte{0x21, 0x12, 0xA4, 0x42} // the magic cookie, big-endian
	xPort := binary.BigEndian.Uint16(xor[2:4]) ^ binary.BigEndian.Uint16(cookie[0:2])
	if xPort != wantPort {
		t.Fatalf("xor mapped port = %d, want %d", xPort, wantPort)
	}
	for i := 0; i < 4; i++ {
		if xor[4+i] != mapped[4+i]^cookie[i] {
			t.Fatalf("xor mapped address byte %d is inconsistent", i)
		}
	}
	if _, ok := attrs[attrFingerprint]; !ok {
		t.Fatal("FINGERPRINT missing")
	}
}

func TestStunServerIgnoresNonBindingAndGarbage(t *testing.T) {
	srv, err := Listen("127.0.0.1:0", nil)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer srv.Close()

	addr, err := net.ResolveUDPAddr("udp", srv.Addr())
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	client, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	var txID [12]byte
	for _, packet := range [][]byte{
		{0x00, 0x01, 0x00},                       // far too short
		buildBindingRequest(txID)[:8],             // truncated header
		append([]byte{0xC0}, make([]byte, 19)...), // top bits set: not STUN
	} {
		if _, err := client.Write(packet); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	// No reply must arrive for any of them.
	buf := make([]byte, 1500)
	_ = client.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if n, err := client.Read(buf); err == nil {
		t.Fatalf("unexpected response of %d bytes", n)
	}
}

func TestParseBindingRequestRejectsBadLengths(t *testing.T) {
	var txID [12]byte
	good := buildBindingRequest(txID)
	if _, ok := parseBindingRequest(good); !ok {
		t.Fatal("a well-formed request was rejected")
	}
	// Length must be a multiple of four and fit inside the packet.
	bad := buildBindingRequest(txID)
	binary.BigEndian.PutUint16(bad[2:4], 3)
	if _, ok := parseBindingRequest(bad); ok {
		t.Fatal("an unaligned length was accepted")
	}
	tooLong := buildBindingRequest(txID)
	binary.BigEndian.PutUint16(tooLong[2:4], 64)
	if _, ok := parseBindingRequest(tooLong); ok {
		t.Fatal("a length past the packet was accepted")
	}
}
