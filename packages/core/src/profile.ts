import { z } from "zod";

import { digest } from "./canonical.js";
import { ExactVersion, Hex32, PackageName, SchemaVersion, isSortedUnique } from "./primitives.js";

export const Language = z.enum(["typescript", "javascript"]);

export const PackageManager = z.enum(["npm", "pnpm", "yarn"]);

export const ModuleSystem = z.enum(["esm", "cjs"]);

/**
 * Web frameworks the bridge can detect from package manifests and lockfiles.
 * MCP roles (server or client) are not detectable from manifests; the task's
 * capability states the role, and the MCP SDK shows up as a dependency.
 */
export const Framework = z.enum(["express", "fastify", "hono", "next"]);

const LOCKFILE_FOR: Record<z.infer<typeof PackageManager>, string> = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};

export const MAX_PROFILE_DEPENDENCIES = 500;

/**
 * Direct dependencies with exact versions. The size cap runs before any entry is
 * parsed, so an oversized map costs one key count. It is a preprocess step
 * rather than `z.custom`, because MCP clients read this schema as JSON Schema
 * and a custom type cannot be represented there; `maxProperties` publishes the
 * same cap to them.
 */
const DependencyMap = z.preprocess<unknown, z.ZodRecord<typeof PackageName, typeof ExactVersion>, Record<string, string>>(
  (value, ctx) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > MAX_PROFILE_DEPENDENCIES) {
      ctx.addIssue({
        code: "too_big",
        origin: "object",
        maximum: MAX_PROFILE_DEPENDENCIES,
        inclusive: true,
        input: value,
        message: `expected at most ${MAX_PROFILE_DEPENDENCIES} dependencies`,
      });
      return z.NEVER;
    }
    return value;
  },
  z.record(PackageName, ExactVersion).meta({ maxProperties: MAX_PROFILE_DEPENDENCIES }),
);

/**
 * The only repository information the bridge sends to the server: allowlisted
 * metadata with no paths, file contents, or free text.
 *
 * `dependencies` holds the repository's direct dependencies with the exact
 * versions resolved from the lockfile. The bridge sends only packages named in
 * the catalog's published interest set for the requested capability, so internal
 * package names do not leave the machine and the profile digest stays stable
 * when unrelated dependencies change.
 */
export const RepositoryProfile = z
  .strictObject({
    schemaVersion: SchemaVersion,
    language: Language,
    runtime: z.strictObject({
      name: z.literal("node"),
      major: z.int().min(0).max(999),
    }),
    packageManager: z.strictObject({
      name: PackageManager,
      lockfile: z.enum(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]),
    }),
    moduleSystem: ModuleSystem,
    dependencies: DependencyMap,
    frameworks: z.array(Framework).max(Framework.options.length),
  })
  .superRefine((profile, ctx) => {
    if (LOCKFILE_FOR[profile.packageManager.name] !== profile.packageManager.lockfile) {
      ctx.addIssue({ code: "custom", path: ["packageManager", "lockfile"], message: "lockfile does not match the package manager" });
    }
    if (!isSortedUnique(profile.frameworks)) {
      ctx.addIssue({ code: "custom", path: ["frameworks"], message: "frameworks must be sorted and unique" });
    }
  });

export type RepositoryProfile = z.infer<typeof RepositoryProfile>;

export function profileDigest(profile: RepositoryProfile): Hex32 {
  return digest("repository-profile", RepositoryProfile.parse(profile));
}
