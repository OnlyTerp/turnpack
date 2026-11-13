## Summary

- What problem does this solve?

## Verification Checklist

- [ ] `npm run verify` passes with zero failures or skipped tests
- [ ] `node dist/cli.js demo` and `node dist/cli.js doctor` pass
- [ ] A test fails without this change and passes with it
- [ ] Zero runtime dependencies added (`"dependencies": {}`)
- [ ] Any claims or numbers match measured command/test output
- [ ] If this touches a safety fence: SECURITY.md is updated and a test tries to get through it
