import { Project } from './Project.js';
import { ProjectChunk } from './ProjectChunk.js';

export type AppSchema = {
  Project: Project;
  ProjectChunk: ProjectChunk;
};

export const schema = [
  Project,
  ProjectChunk,
];
