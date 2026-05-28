# Development Methodology

## Core Principles

1. **Think before coding** — Always analyze the problem, understand existing code, and plan before making changes.
2. **Incremental changes** — Make small, focused commits. Each change should do one thing well.
3. **Verify your work** — Run builds, tests, and linters after every change.
4. **Follow existing patterns** — Match the project's style, conventions, and libraries.

## Workflow

### Before Starting Any Task
- Read and understand the relevant existing code
- Identify dependencies and potential side effects
- Plan the implementation approach

### During Implementation
- Write clean, readable code with appropriate comments
- Handle errors gracefully
- Consider edge cases and security implications
- Keep functions small and focused

### After Implementation
- Run the build/compile step
- Run relevant tests
- Review your own changes for correctness
- Ensure no regressions were introduced

## Code Quality Standards
- Use meaningful variable and function names
- Add type annotations where applicable
- Write self-documenting code; add comments only for "why", not "what"
- Follow DRY (Don't Repeat Yourself) but don't over-abstract
- Prefer composition over inheritance
