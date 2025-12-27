# Publishing Workflow - Quick Reference

## Setup (One-time)

### 1. NPM Account
- Create account at https://npmjs.com
- Verify email

### 2. Generate NPM Token
```bash
npm login
npm token create --type automation
```
Copy the token for GitHub secrets.

### 3. Add GitHub Secret
- Go to: https://github.com/nmhung1210/nodertc/settings/secrets/actions
- Click "New repository secret"
- Name: `NPM_TOKEN`
- Value: (paste your NPM token)
- Click "Add secret"

## Publishing Process

### Option 1: Automated (Recommended)

```bash
# 1. Make sure all changes are committed
git add .
git commit -m "Release v1.0.0"

# 2. Update version and create tag
npm version patch  # or: minor, major

# 3. Push with tags
git push origin main --tags
```

GitHub Actions will automatically:
- Run tests on Node 18, 20, 22
- Build the package
- Publish to NPM

### Option 2: Manual

```bash
# 1. Update version
npm version patch

# 2. Build
npm run build

# 3. Test
npm test

# 4. Publish
npm publish
```

## Version Commands

```bash
npm version patch   # 1.0.0 → 1.0.1 (bug fixes)
npm version minor   # 1.0.0 → 1.1.0 (new features)
npm version major   # 1.0.0 → 2.0.0 (breaking changes)
```

## Verify Package Before Publishing

```bash
# See what will be published
npm pack --dry-run

# Create actual tarball
npm pack

# Extract and inspect
tar -xzf nodertc-*.tgz
ls -la package/
```

## Test Locally

```bash
# In another project
npm install /path/to/nodertc/nodertc-1.0.0.tgz
```

## Rollback (if needed)

```bash
# Unpublish within 72 hours
npm unpublish nodertc@1.0.1

# Or deprecate
npm deprecate nodertc@1.0.1 "Use 1.0.2 instead"
```

## Monitoring

- NPM: https://www.npmjs.com/package/nodertc
- GitHub Actions: https://github.com/nmhung1210/nodertc/actions
- Downloads: https://npmtrends.com/nodertc

## Troubleshooting

### "403 Forbidden"
- Check NPM_TOKEN is valid
- Verify you own the package name
- Try `npm login` and re-authenticate

### "Package version already exists"
- Increment version with `npm version`
- Cannot republish same version

### Tests failing in CI
- Run locally: `npm test`
- Check Node.js version compatibility
- Review GitHub Actions logs

### Build failing
- Ensure Rollup is installed: `npm install`
- Run `npm run build` locally
- Check rollup.config.mjs syntax

## Best Practices

1. ✅ Always test before publishing
2. ✅ Use semantic versioning
3. ✅ Update CHANGELOG.md
4. ✅ Keep README.md current
5. ✅ Test on multiple Node versions
6. ✅ Use `npm pack --dry-run` to preview
7. ✅ Tag releases in Git
8. ✅ Write clear commit messages
