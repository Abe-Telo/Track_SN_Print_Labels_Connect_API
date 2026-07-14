# Fail2ban operations

OrderAssist production uses Fail2ban to protect SSH on port 22.

## Production configuration

- Jail: `sshd`
- Backend: `systemd`
- Action: `nftables-multiport`
- Initial ban: 1 hour
- Detection window: 10 minutes
- Ban after: 5 failures
- Repeat bans: increase by factor 2, maximum 1 week
- Config: `/etc/fail2ban/jail.d/orderassist.local`
- Whitelist: `/etc/fail2ban/jail.d/orderassist-whitelist.local`
- Protected entries: `/etc/fail2ban/orderassist-protected-whitelist.txt`
- Dashboard audit log: `/var/log/orderassist-fail2ban-audit.log`

The web dashboard is available in the left navigation at **Security / Fail2ban**.

## Dashboard capabilities

- Shows active jails and service health
- Shows current and total failed attempts
- Shows current and total bans
- Lists currently blocked IP addresses
- Lists recent ban/unban events
- Shows whitelist entries
- Allows an authenticated operator to:
  - unban an IP
  - add an IP/CIDR to the persistent whitelist
  - remove non-protected whitelist entries

API routes are under `/api/fail2ban/*`. They require the existing OrderAssist
login session. Mutating routes also require the custom
`X-Requested-With: OrderAssistFail2ban` header. Commands use `execFileSync`
without a shell, and IP/jail inputs are validated.

## Common commands

```bash
fail2ban-client ping
fail2ban-client status
fail2ban-client status sshd
fail2ban-client get sshd ignoreip
fail2ban-client set sshd unbanip 203.0.113.10
journalctl -u fail2ban --since "1 hour ago"
tail -100 /var/log/fail2ban.log
```

## Configuration deployment

Repository templates:

- `deploy/fail2ban/orderassist.local`
- `deploy/fail2ban/orderassist-whitelist.local.example`

After changing configuration:

```bash
fail2ban-client -t
systemctl restart fail2ban
fail2ban-client status sshd
```

Always ensure the current trusted admin IP is whitelisted before restarting.

## Notes

- SSH password authentication and root login are currently enabled for legacy
  operations. Fail2ban reduces brute-force risk but does not replace disabling
  password login after all operators have confirmed working SSH keys.
- The server firewall policy was permissive when Fail2ban was installed.
  Fail2ban creates its own nftables sets/chains for banned IPs.
