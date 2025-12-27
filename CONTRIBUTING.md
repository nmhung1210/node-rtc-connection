# Contributing & Publishing Guide

## Development Setup

```bash
# Clone the repository
git clone https://github.com/nmhung1210/nodertc.git
cd nodertc

# Install dependencies
npm install

# Run tests
npm test

# Run specific test suites
npm run test:stun
npm run test:turn
npm run test:integration
```

## Building

The package uses Rollup to build CommonJS and ES Module distributions:

```bash
npm run build
```

This creates:
- `dist/index.cjs` - CommonJS bundle
- `dist/index.mjs` - ES Module bundle
- Source maps for both

## Publishing to NPM

### Manual Publishing

1. Update version in `package.json`:
   ```bash
   npm version patch  # or minor, major
   ```

2. Build and test:
   ```bash
   npm run build
   npm test
   ```

3. Publish to NPM:
   ```bash
   npm publish
   ```

### Automated Publishing with GitHub Actions

The repository includes CI/CD workflows:

#### Test Workflow (`.github/workflows/test.yml`)
- Runs on push to `main` and `develop` branches
- Runs on pull requests
- Tests on Node.js 18.x, 20.x, and 22.x
- Runs all test suites (unit, STUN, TURN)

#### Publish Workflow (`.github/workflows/publish.yml`)
- Triggers on version tags (e.g., `v1.0.0`)
- Runs tests on multiple Node versions
- Builds the package
- Publishes to NPM

**To publish via CI/CD:**

1. Add `NPM_TOKEN` to GitHub repository secrets:
   - Go to npmjs.com → Account → Access Tokens
   - Generate new token (Automation type)
   - Add to GitHub: Settings → Secrets → New repository secret
   - Name: `NPM_TOKEN`

2. Create and push a version tag:
   ```bash
   npm version patch  # Updates package.json
   git push origin main --tags
   ```

3. GitHub Actions will automatically:
   - Run all tests
   - Build the package
   - Publish to NPM

## NPM Package Structure

The published package includes:
- `dist/` - Built CommonJS and ES Module files
- `src/` - Source code (for reference)
- `README.md` - Documentation
- `LICENSE` - MIT License

Excluded from NPM (via `.npmignore`):
- Tests (`test/`)
- Examples (`examples/`)
- Documentation files
- Docker configuration
- CI/CD workflows

## Release Checklist

Before releasing a new version:

- [ ] All tests passing (`npm test`)
- [ ] Documentation updated
- [ ] CHANGELOG.md updated (if exists)
- [ ] Version bumped in package.json
- [ ] Git tag created
- [ ] Built files verified (`npm run build`)

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR** version for incompatible API changes
- **MINOR** version for new functionality (backward-compatible)
- **PATCH** version for bug fixes (backward-compatible)

## Testing Before Publish

Test the package locally before publishing:

```bash
# Build the package
npm run build

# Pack it to see what will be published
npm pack

# This creates nodertc-X.Y.Z.tgz
# Extract and inspect:
tar -xzf nodertc-*.tgz
ls -la package/
```

Or test in another project:

```bash
# In your test project
npm install /path/to/nodertc
```

## Support

- Issues: https://github.com/nmhung1210/nodertc/issues
- Pull Requests: https://github.com/nmhung1210/nodertc/pulls
