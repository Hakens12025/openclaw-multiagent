// Input-field definitions for skills.* admin surfaces.
// skills.create lets operator author a domain skill (SKILL.md) — the ONLY sanctioned
// domain-knowledge injection channel per the 通用机 principle. Its payload must be schema'd
// (not blank) or the planner blind-guesses skillId/description/body and the validator cannot
// catch a missing required field. Handler: lib/admin/skill-author.js createSkillDefinition.

export const SKILLS_INPUT_FIELDS = Object.freeze({
  "skills.create": [
    {
      key: "skillId",
      label: "SKILL ID",
      type: "text",
      required: true,
      aliases: ["id", "name"],
      placeholder: "factor-mining-method",
      description: "kebab-case ^[a-z0-9][a-z0-9-]{1,48}$. New-only (won't overwrite builtins).",
    },
    {
      key: "description",
      label: "DESCRIPTION",
      type: "textarea",
      required: true,
      placeholder: "When to use + what domain knowledge it carries.",
      description: "Becomes SKILL.md frontmatter description (relevance routing reads it).",
    },
    {
      key: "body",
      label: "SKILL BODY",
      type: "textarea",
      placeholder: "# Method\n领域处理方法 / 数据 schema / 检查项 ...",
      description: "Optional SKILL.md markdown body: the domain-specific method, schema, and rules.",
    },
  ],
});
