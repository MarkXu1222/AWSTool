# Coding Standards

## General Rules
- All code must be production-quality — no placeholder or TODO-only implementations
- Error handling is mandatory, not optional
- Security best practices by default (input validation, parameterized queries, proper auth)
- Accessibility compliance for any UI components

## Git Conventions
- Commit messages: use conventional commits format (feat:, fix:, docs:, refactor:, test:)
- Branch naming: feature/, fix/, docs/ prefixes
- Keep commits atomic and focused

## Documentation
- Every public API must have documentation
- README should be kept up to date with setup and usage instructions
- Architecture decisions should be recorded in this steering directory

## Testing
- Write tests for new features and bug fixes
- Tests should be readable and serve as documentation
- Prefer integration tests over unit tests for business logic
- Mock external dependencies only

## Frontend Style Rules (web/client)
- Colors: only `var(--color-*)` tokens from global.css — never raw hex in components. Gray scale is exactly 3 levels: secondary `#4a5468` / muted `#8a94a6` / disabled `#b6bdca`.
- z-index: only `var(--z-*)` tokens (sider 100 / overlay 900 / bottom-nav 1000) — no magic numbers.
- Font weight rhythm: table headers 500, card/section titles 600, page titles 700.
- Icons: AntD icons with semantic color tokens; never emoji as UI icons.
- Inline `style={{}}`: acceptable for one-off layout tweaks; any pattern repeated 3+ times must become a class in global.css (existing debt in TagCompliance/Accounts/Quotas to be reduced opportunistically).
- Success messages: no exclamation marks; be confident, not loud.
- AntD theme: brand tokens live in main.tsx ConfigProvider AND :root CSS vars — change both together.

## AWS Specific
- Use IAM least-privilege principle
- Tag all resources appropriately
- Prefer managed services over self-hosted
- Use Infrastructure as Code (IaC) for all deployments
- Store secrets in AWS Secrets Manager or Parameter Store, never in code
