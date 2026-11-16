# Security policy

Lexi gives an AI agent write access to GitHub and Slack, so security reports are especially welcome.

## Reporting a vulnerability

Please **do not open a public issue** with details. Report it privately through GitHub's [private vulnerability reporting](https://github.com/deriv-com/lexi/security/advisories/new) for this repository.

If that link does not offer you a form (private reporting can be switched off on a repository or a fork), open a minimal public issue that says only that you have a security report and asks for a private contact. Leave out every detail of the problem; a maintainer will reply with a private channel.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within three working days and will keep you updated until the issue is resolved.

## What is in scope

- Bypassing authorization or policy checks, so the agent performs a write it should have refused.
- Prompt injection that makes the agent act on instructions from content it reads (issues, pull requests, Slack messages, files) rather than from the requesting user.
- Leaking credentials, tokens or data across users, threads or repositories.
- The reusable GitHub Actions workflows in this repository, including how they handle tokens and untrusted input.

## Supported versions

Lexi has not had a public release yet. Once it does, security fixes will go to the latest release.
