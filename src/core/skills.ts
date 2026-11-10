import { tool, type ToolSet } from "ai";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { config } from "./config";

export type Skill = { name: string; description: string; body: string };

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Single-line `key: value` frontmatter, which is all Agent Skills require. */
export function parseSkill(source: string): Skill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const { name, description } = fields;
  if (!name || !description || !SKILL_NAME.test(name)) return null;
  return { name, description, body: match[2].trim() };
}

/**
 * Every <dir>/<skill>/SKILL.md, sorted by name. Read on every turn, so adding
 * or editing a skill needs no restart. Missing dir or SKILLS_DIR="" means none.
 */
export function loadSkills(): Skill[] {
  const dir = config.skillsDir;
  if (!dir) return [];
  let entries: string[];
  try {
    entries = readdirSync(resolve(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills = new Map<string, Skill>();
  for (const entry of entries.sort()) {
    let source: string;
    try {
      source = readFileSync(join(resolve(dir), entry, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const skill = parseSkill(source);
    if (!skill) console.error(`[skills] ${entry}/SKILL.md has no valid name and description, skipping`);
    else if (skills.has(skill.name)) console.error(`[skills] duplicate skill name ${skill.name}, skipping ${entry}`);
    else skills.set(skill.name, skill);
  }
  return [...skills.values()];
}

export const LOAD_SKILL = "load_skill";

export function buildSkillTools(skills: Skill[]): ToolSet {
  if (!skills.length) return {};
  return {
    [LOAD_SKILL]: tool({
      description:
        "Load the full instructions of one of the skills listed in the system prompt. " +
        "Call it before doing a task the skill covers. What it returns lasts for the current turn only.",
      inputSchema: z.object({ name: z.string().describe("The skill's name, exactly as listed") }),
      execute: async ({ name }) => {
        const skill = skills.find((s) => s.name === name);
        if (!skill) return { error: `No skill named ${name}. Available: ${skills.map((s) => s.name).join(", ")}` };
        return skill.body;
      },
    }),
  };
}
