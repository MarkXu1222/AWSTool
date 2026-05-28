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

## AWS Specific
- Use IAM least-privilege principle
- Tag all resources appropriately
- Prefer managed services over self-hosted
- Use Infrastructure as Code (IaC) for all deployments
- Store secrets in AWS Secrets Manager or Parameter Store, never in code
