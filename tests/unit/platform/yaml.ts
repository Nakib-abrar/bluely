import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * YAML for the packaging tests: js-yaml, a pinned devDependency in package.json (the same
 * version electron-builder reads electron-builder.yml with). It ships without types.
 */
export const loadYaml = (require('js-yaml') as { load: (src: string) => unknown }).load

/** The version loadYaml comes from, checked against package.json in docs.test.ts. */
export const yamlVersion = (require('js-yaml/package.json') as { version: string }).version
