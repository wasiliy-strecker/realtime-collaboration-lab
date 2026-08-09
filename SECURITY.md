# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories. Do not open a public issue containing exploit details, credentials,
or user data.

## Supported versions

Security fixes target the latest tagged release and the `main` branch.

## Demo boundary

Local Compose credentials are intentionally non-production values. The signed
demo-session mechanism is not intended to replace an identity provider. Public
deployments must use TLS, a strong session secret, strict origin allowlists, and
network controls appropriate to their environment.

The browser never stores the signed session token in JavaScript-accessible
storage. It stores only the public actor and board identifiers, the confirmed
demo snapshot, and pending demo commands. Do not use the release room for
confidential data without adding an audited identity, authorization, retention,
and browser-storage policy.
