# Copilot Custom Instructions for GitHub-UserScripts

## Version Bumping Rules

When making changes to any `.user.js` file in this repository, you **MUST** update the `@version` field in the UserScript header metadata. This ensures TamperMonkey detects updates and prompts users to install the new version.

### Semantic Versioning (SemVer)

Use semantic versioning (`MAJOR.MINOR.PATCH`) and decide the appropriate version bump based on the type of change:

- **MAJOR** (e.g., `0.1.4` → `1.0.0`): Breaking changes or significant rewrites
  - Complete rewrite of core functionality
  - Changes that break backward compatibility
  - Major UI/UX overhauls

- **MINOR** (e.g., `0.1.4` → `0.2.0`): New features or enhancements
  - Adding new buttons or controls
  - Adding support for new GitHub page types
  - New configuration options
  - Significant feature additions

- **PATCH** (e.g., `0.1.4` → `0.1.5`): Bug fixes and small changes
  - Bug fixes
  - Code refactoring without behavior changes
  - Adding support for new button text variants
  - Documentation updates in code comments
  - Minor tweaks and adjustments

### Example

```javascript
// Before change
// @version      0.1.4

// After a bug fix (PATCH)
// @version      0.1.5

// After adding a new feature (MINOR)
// @version      0.2.0

// After a breaking change (MAJOR)
// @version      1.0.0
```

Always update the version even for small changes - TamperMonkey relies on this to notify users of updates.
