// Never inherit a developer's fixed code in the test environment.
delete process.env.DEV_FIXED_CODE;
