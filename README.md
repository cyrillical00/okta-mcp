# okta-mcp

MCP server for Okta IT operations. Okta ships an official MCP server for developers. This one is for IT operators, with incident-derived runbook tools built from real production incidents.

## Tools

### Read tools
| Tool | Description |
|---|---|
| `okta_get_user` | Fetch a user by ID, email, or login |
| `okta_search_users` | Search users with filter, search, or starts-with modes |
| `okta_list_group_users` | List members of a group |
| `okta_list_user_factors` | List enrolled MFA factors for a user |
| `okta_list_groups` | List groups with optional filter |
| `okta_get_group` | Fetch a group by ID or exact name |
| `okta_list_apps` | List applications with optional filter |
| `okta_list_user_apps` | List apps assigned to a user |
| `okta_get_app_signon_policies` | Get sign-on policy and rules for an app |
| `okta_get_user_device_trust_status` | Derive device trust status for a user |
| `okta_list_bypass_group_members` | List members of a bypass/exemption group with last-login metrics |
| `okta_get_system_log` | Query the Okta system log by actor, target, event type, or outcome |
| `okta_resolve_identifier` | Resolve an ambiguous identifier to users, groups, or apps |

### Write tools (all require confirmation)
| Tool | Description |
|---|---|
| `okta_activate_user` | Activate a deprovisioned or staged user |
| `okta_deactivate_user` | Deactivate a user |
| `okta_suspend_user` | Suspend an active user |
| `okta_unlock_user` | Unlock a locked-out user |
| `okta_clear_user_sessions` | Revoke sessions and optionally OAuth tokens |
| `okta_reset_user_factor` | Reset a specific MFA factor enrollment |
| `okta_add_user_to_group` | Add a user to a group |
| `okta_remove_user_from_group` | Remove a user from a group |
| `okta_assign_app_to_user` | Directly assign an app to a user |
| `okta_remove_app_from_user` | Remove a direct app assignment |

### Runbook tools
| Tool | Description |
|---|---|
| `okta_runbook_device_trust_bypass_audit` | Audit all members of a bypass group with device and login metrics |
| `okta_runbook_offboard_user` | Suspend, clear sessions, return full audit record |
| `okta_runbook_access_review_for_app` | Generate SOC2/SOX access review table for an app |

## Setup

### Prerequisites

- Node.js 20+
- Claude Desktop
- Okta org with Super Admin access

### 1. Create the Okta service app

In the Okta Admin Console:

1. Applications > Applications > Create App Integration > API Services
2. Name it anything (e.g. `okta-mcp-server`), Save
3. General tab > Client Credentials > Edit > select **Public key / Private key** > Save
4. Public Keys > Add key > Generate new key > JWK tab > copy the JSON > Done
5. Okta API Scopes tab > grant all 12 scopes listed in `.env.example`
6. Security > Administrators > Add administrator > select the service app > Super Administrator

### 2. Configure environment

```
cp .env.example .env
```

Fill in:
- `OKTA_DOMAIN` - your org domain, no scheme (e.g. `mycompany.okta.com`)
- `OKTA_CLIENT_ID` - from the app's General tab
- `OKTA_PRIVATE_KEY_PATH` - absolute path to the JWK JSON you downloaded
- `OKTA_SCOPES` - copy as-is from `.env.example`

### 3. Install and verify

```
npm install
npm run verify-auth
```

A passing probe prints your org ID and assigned roles. Any misconfiguration exits with a specific error code and remediation hint.

### 4. Register in Claude Desktop

```
npm run generate-config
```

Paste the output into your `claude_desktop_config.json` under `mcpServers`. Restart Claude Desktop.

Config file location:
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

## Security model

- **Auth**: Private Key JWT (PKJWT) via Okta service app. No API tokens, no user credentials.
- **Scopes**: Minimal set of `okta.*` admin scopes, granted explicitly per section above.
- **Write gating**: All destructive operations require confirmation via MCP Elicitation API before executing. Clients without elicitation support get a `CONFIRMATION_REQUIRED` error on first call and must re-invoke with `_confirmed: true`.
- **Audit log**: Every tool invocation appended to `logs/okta-mcp-audit-YYYY-MM-DD.jsonl` with input (redacted), output summary, duration, and Okta request ID.
- **Demo mode**: Set `OKTA_MCP_ALLOW_WRITES=false` to disable all write operations.
- **Key protection**: Private key never leaves the local filesystem. `.gitignore` blocks `keys/*.json` and `keys/*.pem`.

## Architecture

```
Claude Desktop
    |
    | stdio (MCP protocol)
    v
okta-mcp server (Node.js, tsx)
    |
    | @okta/okta-sdk-nodejs (PKJWT auth)
    v
Okta Admin API
```

Startup sequence: env validation > private key check > token exchange > admin role verification > tool registration > stdio transport connect.

## Scripts

| Script | Purpose |
|---|---|
| `npm run verify-auth` | Standalone auth probe, exits 0 on success with org/role info |
| `npm run probe-sdk` | Regenerate `docs/okta-sdk-v8-methods.md` from live SDK |
| `npm run generate-config` | Print Claude Desktop config snippet for this machine |
| `npm run dev` | Run server directly with tsx (for testing) |
| `npm run typecheck` | TypeScript check without emit |

## License

MIT
