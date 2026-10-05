import type { ProjectSummary, SessionUser, StudioProblem } from "@mona/shared";
import { create } from "zustand";

interface StudioState {
  user: SessionUser | null;
  accessToken: string;
  refreshToken: string;
  activeProject: ProjectSummary | null;
  problems: StudioProblem[];
  setSession: (user: SessionUser, accessToken: string, refreshToken: string) => void;
  updateTokens: (accessToken: string, refreshToken: string) => void;
  setProject: (project: ProjectSummary | null) => void;
  setProblems: (problems: StudioProblem[]) => void;
  logout: () => void;
}

export const useStudio = create<StudioState>((set) => ({
  user: null, accessToken: "", refreshToken: "", activeProject: null, problems: [],
  setSession: (user, accessToken, refreshToken) => set({ user, accessToken, refreshToken }),
  updateTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
  setProject: (activeProject) => set({ activeProject, problems: [] }),
  setProblems: (problems) => set({ problems }),
  logout: () => set({ user: null, accessToken: "", refreshToken: "", activeProject: null, problems: [] }),
}));
