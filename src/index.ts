/** 核心机制层公共出口。GUI 阶段通过该入口访问全部能力。 */

export * from './domain/models.js';
export * from './domain/genres.js';
export * from './db/schema.js';
export * from './db/sqlite.js';
export * from './db/mappers.js';
export * from './db/id.js';
export * from './db/book-repository.js';
export * from './db/fact-source-repository.js';
export * from './db/snapshot-repository.js';
export * from './gates/index.js';
export * from './audit/index.js';
export * from './assembly/assembler.js';
export * from './retrieval/index.js';
export * from './projection/markdown.js';
export * from './import/manuscript.js';
export * from './import/obsidian.js';
