import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class AuditValidationTests(unittest.TestCase):
    def check_report(self, report, exceptions="version: 1\nexceptions:\n"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "audit.json").write_text(json.dumps(report), encoding="utf-8")
            (root / "exceptions.yml").write_text(exceptions, encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(Path(__file__).with_name("check_pnpm_audit_exceptions.py")),
                 "--audit", str(root / "audit.json"), "--exceptions", str(root / "exceptions.yml")],
                capture_output=True, text=True,
            )

    def test_empty_success_report_passes(self):
        self.assertEqual(self.check_report({"advisories": {}}).returncode, 0)

    def test_network_errors_and_incomplete_reports_fail(self):
        for report in [
            {}, [], {"error": {"code": "ENOTFOUND"}},
            {"code": "ERR_PNPM_AUDIT_BAD_RESPONSE", "advisories": {}},
            {"advisories": []}, {"advisories": {"1": {}}},
            {"advisories": {}, "metadata": {"vulnerabilities": {"high": 1}}},
            {"vulnerabilities": {"axios": {"severity": "high", "via": []}}},
        ]:
            with self.subTest(report=report):
                self.assertNotEqual(self.check_report(report).returncode, 0)

    def test_high_vulnerability_requires_exact_unexpired_exception(self):
        report = {"advisories": {"1": {
            "module_name": "xlsx", "severity": "high",
            "github_advisory_id": "GHSA-4r6h-8v6p-xvw6",
        }}}
        exception = (
            "version: 1\nexceptions:\n  - package: xlsx\n"
            "    advisory: GHSA-4r6h-8v6p-xvw6\n    severity: high\n"
            "    mitigation: Export only; never parse external files\n"
            "    expires_on: 2999-01-01\n"
        )
        self.assertNotEqual(self.check_report(report).returncode, 0)
        self.assertEqual(self.check_report(report, exception).returncode, 0)
        self.assertNotEqual(self.check_report(report, exception.replace("2999-01-01", "2000-01-01")).returncode, 0)
        self.assertNotEqual(self.check_report(report, exception.replace("package: xlsx", "package: axios")).returncode, 0)


if __name__ == "__main__":
    unittest.main()
