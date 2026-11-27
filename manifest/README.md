# Fingers permission manifest

`fingers.json` lists what an organization can allow its people to do with
Fingers. Veyra Connect shows it as the Fingers tab of each permission group,
and Fingers checks a person's grants when they sign in with their organization.
`cli:use` covers signing in with `fingers login` and using the organization's
model connections.

| File | What it is |
| --- | --- |
| `fingers.json` | The manifest. |
| `permission-manifest.schema.json` | The JSON Schema it follows. |
| `SOURCE.json` | Where both files come from and their SHA-256 hashes. |

The manifest is defined in the Veyra platform contracts. These files are
copies of it, so do not edit them here. To change the manifest:

1. Publish a new manifest `version` in the platform contracts.
2. Copy the files here.
3. Update `SOURCE.json`.

Connect never changes a version that is already registered. It refuses a
manifest with different content under the same version number.

## Registering it with Connect

The other Veyra apps register their manifest each time they start. Fingers has
no server, so each release runs `scripts/register-manifest.mjs` once per
environment. The script needs Node 22 or newer and nothing else. It has to run
where it can reach Connect's internal listener, which is only reachable from
inside the cluster.

```sh
# Check the manifest without sending anything
node scripts/register-manifest.mjs --check

# Local stack: use the instance file that Connect's dev seed writes
node scripts/register-manifest.mjs \
  --connect-url "$CONNECT_INTERNAL_URL" \
  --instance-file path/to/fingers-instance.json

# A deployed environment: give the Fingers instance through the environment
VEYRA_CONNECT_INTERNAL_URL="$CONNECT_INTERNAL_URL" \
VEYRA_INSTANCE_ID=inst_... VEYRA_INSTANCE_KEY='{"kty":"OKP","crv":"Ed25519",...}' \
VEYRA_ENV=prod node scripts/register-manifest.mjs
```

The script signs the registration with the instance's Ed25519 key and sends
it. If the request fails because of the network, a `429` or a `5xx`, it waits
and tries again with a new signature. It never logs the key or the signed
body. Each line it prints to stdout is a JSON log record with `request_id`
and `trace_id`.

| Exit code | Meaning |
| --- | --- |
| `0` | Connect registered the manifest, or already had the same version with the same content. |
| `1` | Connect refused the manifest (for example `409 manifest_version_taken`), or the script gave up after `--max-attempts`. |
| `2` | The arguments or the configuration are wrong. |
