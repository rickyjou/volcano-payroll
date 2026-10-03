// The tool registry. A user only ever sees the tools for their role; RLS and the
// Functions' own checks remain the real security boundary.
import type { AgentTool, Role } from '../types';
import { TIME_TOOLS } from './time';

export const ALL_TOOLS: AgentTool[] = [...TIME_TOOLS];

export const toolsFor = (role: Role): AgentTool[] => ALL_TOOLS.filter((t) => t.roles.includes(role));

export const toolByName = (name: string): AgentTool | undefined => ALL_TOOLS.find((t) => t.name === name);
