# SEP outbound egress policy

SEP-1, SEP-10, and SEP-38 use the shared transport in
`lib/stellar/outboundEgress.ts` for production requests. Public API reads use
persisted data and do not invoke this policy.

## Address policy

The resolver requests both A and AAAA records. Every answer must be a parsed,
globally routable unicast address. The request is denied when resolution fails,
times out, returns no addresses, returns malformed data, or mixes allowed and
disallowed answers.

| Address class | Decision |
| --- | --- |
| Globally routable IPv4 or IPv6 unicast | Allow |
| Unspecified, loopback, link-local, private/unique-local | Deny |
| Carrier-grade NAT and benchmarking | Deny |
| Multicast, documentation, reserved and future-use ranges | Deny |
| IPv4-mapped IPv6 | Classify the embedded IPv4 address |
| NAT64 local-use/well-known, discard-only, Teredo and 6to4 | Deny |
| Any mixed allowed/disallowed DNS answer set | Deny the whole set |

DNS work is limited to one A and one AAAA query and a two-second default DNS
deadline. A successful decision logs only a bounded hostname, decision,
reason, and answer count. Paths, query strings, headers, credentials, response
bodies, and resolved addresses are not logged.

## Rebinding and TLS

After validating the complete answer set, the transport selects one validated
address and supplies it directly through the HTTPS socket's `lookup` callback.
There is no second DNS lookup, so a later DNS change cannot redirect that
connection. The URL hostname remains unchanged and is explicitly used as TLS
SNI; Node's normal CA and hostname verification remain enabled. Redirects are
still disabled by each SEP client.

## Runtime assumptions and residual limits

The production implementation requires the Node.js runtime and its `https`
socket controls. It deliberately fails closed rather than falling back to the
platform `fetch` implementation when address pinning cannot be guaranteed.
Edge runtimes without equivalent DNS and connection pinning are unsupported.

This application-layer boundary does not replace a deployment egress firewall.
Operators of self-hosted deployments should also deny private, metadata, and
control-plane destinations at the network layer. DNS answers can change between
separate requests; every request is therefore resolved, checked, and pinned
independently.

Tests use injected synthetic resolvers and transports. They are policy and
transport evidence only and must not be presented as live-anchor availability
evidence.
