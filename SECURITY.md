# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories. Do not open a public issue containing exploit details, credentials,
or user data.

## Supported versions

Security fixes target the latest tagged release and the `main` branch.

## Demo boundary

Local Compose credentials are intentionally non-production values. The later
demo-session mechanism is not intended to replace an identity provider. Public
deployments must use TLS, a strong session secret, strict origin allowlists, and
network controls appropriate to their environment.
