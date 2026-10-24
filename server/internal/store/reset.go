package store

import "context"

// Reset wipes every row and restores the default settings. It exists for tests
// and for `make reset` on a development database — never call it in production.
func (s *Store) Reset(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		truncate table
			messages, credit_ledger, attestations, escrows, beacons,
			traces, bans, admin_audit, agents
		restart identity cascade`)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		update settings set value = case key
			when 'registration_open' then 'true'::jsonb
			when 'maintenance_mode' then 'false'::jsonb
			when 'send_rate_limit_per_minute' then '120'::jsonb
			when 'register_rate_limit_per_minute' then '30'::jsonb
			else value end,
			updated_at = now()`)
	return err
}
