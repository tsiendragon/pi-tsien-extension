import assert from "node:assert/strict";
import test from "node:test";

import { aggregateTestOutput, isTestCommand } from "pi-tsien-rtk-fork/src/rtk/techniques/test-output.ts";
import { filterBuildOutput, isBuildCommand } from "pi-tsien-rtk-fork/src/rtk/techniques/build.ts";
import { aggregateLinterOutput, isLinterCommand } from "pi-tsien-rtk-fork/src/rtk/techniques/linter.ts";

test("vendored RTK does not treat ordinary commands as test runs", () => {
	for (const command of [
		"ls test",
		"cat test",
		"rm -rf test",
		"echo test",
		"grep -c test file.txt",
		"cd test",
		"find . -name test",
	]) {
		assert.equal(isTestCommand(command), false, command);
		assert.equal(aggregateTestOutput("-rw-r--r-- 1 u g 0 Jan 1 test\n", command), null, command);
	}
});

test("vendored RTK still recognizes real test runners", () => {
	for (const command of [
		"npm test",
		"npm run test",
		"npm run test:node",
		"yarn test",
		"pnpm test",
		"bun test",
		"node --test",
		"node --import tsx --test test/x.test.ts",
		"npx vitest run",
		"vitest run",
		"jest",
		"pytest -q",
		"mocha",
		"go test ./...",
		"cargo test",
		"cd repo && npm test",
	]) {
		assert.equal(isTestCommand(command), true, command);
	}
});

test("vendored RTK does not treat substrings as builds", () => {
	for (const command of [
		"grep -rn tsc .",
		"cat makefile",
		"rg make",
		"echo tsc",
		"git log --grep=mvn",
		"python -c 'print(\"mvn\")'",
	]) {
		assert.equal(isBuildCommand(command), false, command);
		assert.equal(filterBuildOutput("hello\ntsc\n", command), null, command);
	}
});

test("vendored RTK does not treat substrings as linter runs", () => {
	for (const command of [
		// a real one: the python heredoc below mined signals whose reason code
		// contains "Global Blacklist" and its whole table was replaced by
		// "✓ Linter: No issues found"
		`python3 - <<'PY'\nKW = ["New True IP Org in Global Blacklist"]\nPY`,
		"grep -rn ruff .",
		"rg black src/",
		"echo eslint",
		`python -c 'print("mypy")'`,
		"cat prettier.config.js",
		"git log --grep=clippy",
		"ls test/black",
	]) {
		assert.equal(isLinterCommand(command), false, command);
		assert.equal(aggregateLinterOutput("table row 1\ntable row 2\n", command), null, command);
	}
});

test("vendored RTK still recognizes real linter runs", () => {
	for (const command of [
		"ruff check .",
		"/usr/local/bin/ruff check .",
		"python3 -m ruff check .",
		"npx eslint src",
		"bunx prettier --check .",
		"poetry run ruff check",
		"cd repo && ruff check .",
		"cargo clippy",
		"black --check .",
		"ruff check . 2>&1 | tail -5",
	]) {
		assert.equal(isLinterCommand(command), true, command);
	}
	assert.equal(aggregateLinterOutput("All checks passed!\n", "ruff check ."), "✓ Ruff: No issues found");
});

test("vendored RTK still recognizes real build commands", () => {
	for (const command of [
		"tsc --noEmit",
		"node_modules/.bin/tsc --noEmit",
		"npx tsc -p .",
		"make",
		"sudo make install",
		"cmake .",
		"gradle build",
		"mvn package",
		"cargo build",
		"cargo check",
		"bun build x.ts",
		"npm run build",
		"yarn build",
		"pnpm build",
		"go build ./...",
		"go install",
		"pip install foo",
		"python setup.py build",
	]) {
		assert.equal(isBuildCommand(command), true, command);
	}
});