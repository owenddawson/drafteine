# Security Policy

## Supported versions

The latest release on the [releases page](https://github.com/owenddawson/drafteine/releases)
is the supported version. Pre-1.0 releases do not receive backported fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them
privately through
[GitHub security advisories](https://github.com/owenddawson/drafteine/security/advisories/new).

Relevant areas for this project: path traversal in `apply`, `check`,
`snapshot`, or template resolution, and anything that lets a draft or
config write outside its declared root. Reports in those areas are
especially appreciated and will be prioritized.
