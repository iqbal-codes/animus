import json
from pathlib import Path
import unittest


class TestSkillsIntegrity(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(__file__).resolve().parent.parent
        self.claude_skills = self.root / ".claude" / "skills"
        self.agents_skills = self.root / ".agents" / "skills"

    def _parse_frontmatter(self, text: str) -> dict[str, str]:
        lines = text.splitlines()
        if not lines or lines[0].strip() != "---":
            return {}
        fm: dict[str, str] = {}
        idx = 1
        while idx < len(lines):
            line = lines[idx].strip()
            if line == "---":
                break
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
            idx += 1
        return fm

    def test_skills_directory_exists_and_contains_skills(self) -> None:
        self.assertTrue(self.claude_skills.is_dir(), ".claude/skills must exist")
        self.assertTrue(self.agents_skills.exists(), ".agents/skills must exist")

        expected_skills = [
            "tdd",
            "diagnosing-bugs",
            "factory-spec",
            "factory-tickets",
            "factory-harness",
        ]
        for skill_name in expected_skills:
            skill_dir = self.claude_skills / skill_name
            self.assertTrue(
                skill_dir.is_dir(), f"Skill directory {skill_name} must exist"
            )
            skill_file = skill_dir / "SKILL.md"
            self.assertTrue(
                skill_file.is_file(), f"{skill_name}/SKILL.md must exist"
            )

            # Test YAML frontmatter
            content = skill_file.read_text(encoding="utf-8")
            fm = self._parse_frontmatter(content)
            self.assertIn("name", fm, f"{skill_name} frontmatter missing 'name'")
            self.assertIn(
                "description", fm, f"{skill_name} frontmatter missing 'description'"
            )
            self.assertEqual(fm["name"], skill_name)

    def test_vendored_skills_attribution_and_mit_license(self) -> None:
        for skill_name in ["tdd", "diagnosing-bugs"]:
            skill_file = self.claude_skills / skill_name / "SKILL.md"
            content = skill_file.read_text(encoding="utf-8")
            self.assertIn("Matt Pocock", content, f"{skill_name} must attribute Matt Pocock")
            self.assertIn("MIT License", content, f"{skill_name} must include MIT License notice")

    def test_factory_skills_canonical_labels(self) -> None:
        spec_content = (self.claude_skills / "factory-spec" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        tickets_content = (self.claude_skills / "factory-tickets" / "SKILL.md").read_text(
            encoding="utf-8"
        )

        canonical_labels = ["ready-for-agent", "needs-info", "ready-for-human", "wontfix"]
        for label in canonical_labels:
            self.assertTrue(
                label in spec_content or label in tickets_content,
                f"Canonical label {label} must be referenced in factory skills",
            )

        # Ensure legacy primary instructions are replaced
        self.assertNotIn("Add `factory:ready` only to complete", tickets_content)
        self.assertNotIn("use `factory:exclude` and the appropriate", spec_content)

    def test_factory_harness_observable_completion_criteria(self) -> None:
        harness_file = self.claude_skills / "factory-harness" / "SKILL.md"
        self.assertTrue(harness_file.is_file(), "factory-harness/SKILL.md must exist")
        content = harness_file.read_text(encoding="utf-8")
        self.assertIn("## When to Use", content)
        self.assertIn("## Steps", content)
        self.assertIn("Completion Criterion", content)

    def test_harness_authoring_standard_doc(self) -> None:
        std_doc = self.root / "docs" / "agents" / "harness-authoring-standard.md"
        self.assertTrue(std_doc.is_file(), "harness-authoring-standard.md must exist")
        content = std_doc.read_text(encoding="utf-8")
        self.assertIn("Imperative", content)
        self.assertIn("2 sentences", content)
        self.assertIn("evidence", content)

    def test_baseline_factory_tool_guidance_and_lessons(self) -> None:
        guidance_file = self.root / ".factory" / "tool-guidance.json"
        lessons_file = self.root / ".factory" / "lessons.jsonl"

        self.assertTrue(guidance_file.is_file(), "tool-guidance.json must exist")
        self.assertTrue(lessons_file.is_file(), "lessons.jsonl must exist")

        guidance_data = json.loads(guidance_file.read_text(encoding="utf-8"))
        self.assertIsInstance(guidance_data, dict)
        self.assertIn("test", guidance_data)

        # Validate lessons format
        lines = [line.strip() for line in lessons_file.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertGreater(len(lines), 0, "lessons.jsonl should have at least one baseline lesson")
        for line in lines:
            lesson = json.loads(line)
            self.assertIn("id", lesson)
            self.assertIn("topic", lesson)
            self.assertIn("trigger_patterns", lesson)
            self.assertIn("rule", lesson)
            self.assertIn("evidence", lesson)
            self.assertIn("vetoed", lesson)
            self.assertIn("created_at", lesson)

    def test_agents_md_lean_and_context_pointers(self) -> None:
        agents_md = self.root / "AGENTS.md"
        self.assertTrue(agents_md.is_file(), "AGENTS.md must exist")
        content = agents_md.read_text(encoding="utf-8")
        lines = content.splitlines()
        self.assertLess(len(lines), 150, f"AGENTS.md must be under 150 lines (currently {len(lines)})")
        self.assertIn(".factory/tool-guidance.json", content)
        self.assertIn(".factory/lessons.jsonl", content)
        self.assertIn("docs/agents/", content)


if __name__ == "__main__":
    unittest.main()
