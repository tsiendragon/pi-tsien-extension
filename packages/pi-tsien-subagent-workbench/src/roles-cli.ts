/**
 * 角色清单校验 CLI（机器可读输出，供 ~/.pi/agent/rules/build.py 或运维脚本使用）。
 *
 * 用法：
 *   node --import tsx src/roles-cli.ts            # 人类可读清单
 *   node --import tsx src/roles-cli.ts --json     # JSON（roleValidationReport 原样）
 *   node --import tsx src/roles-cli.ts --json --strict   # 有非法角色或缺失 prompt 时退出码 1
 *
 * 环境变量：PI_SUBAGENT_ROLES_DIR / PI_SUBAGENT_PROMPT_DIR（同 roles-registry.ts）。
 */
import {
	formatRoleValidationReport,
	roleValidationReport,
} from "./roles-registry.ts";

function main(argv: readonly string[]): number {
	const report = roleValidationReport();
	if (argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		process.stdout.write(`${formatRoleValidationReport(report)}\n`);
	}
	if (argv.includes("--strict") && (report.invalid.length || report.missingPrompts.length)) {
		return 1;
	}
	return 0;
}

process.exitCode = main(process.argv.slice(2));