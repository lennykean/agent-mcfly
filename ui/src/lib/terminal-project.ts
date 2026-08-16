import type { WorkspaceSource } from '../types';
import { normPath } from './timeline';

export interface TerminalProject {
  cwd: string;
  source?: WorkspaceSource;
}

export const terminalProjectKey = (project: TerminalProject) =>
  `${project.source?.connection ?? ''}\0${normPath(project.cwd.replace(/[\\/]+$/, ''))}`;

export const sameTerminalProject = (a?: TerminalProject, b?: TerminalProject) =>
  !!a && !!b && terminalProjectKey(a) === terminalProjectKey(b);

export const terminalProjectScope = (project: TerminalProject) =>
  project.source ? `${project.source.connection}\0${project.cwd}` : project.cwd;
