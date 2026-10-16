import type {
  ApprovalRuleDto,
  CheckpointListResponse,
  MemoryListResponse,
  WebSearchStatus,
  CatalogResponse,
  HarnessListResponse,
  RecentWorkspacesResponse,
  EndpointListResponse,
  ModelListResponse,
  ModelProfileResponse,
  RequestLogResponse,
  Settings,
  SettingsPatch,
  ThreadDetailDto,
  ThreadListResponse,
} from "@ezclaw/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export const keys = {
  settings: ["settings"] as const,
  catalog: ["catalog"] as const,
  endpoints: ["endpoints"] as const,
  models: ["models"] as const,
  profile: (id: string) => ["model-profile", id] as const,
  threads: (mode: string) => ["threads", mode] as const,
  thread: (id: string) => ["thread", id] as const,
  requestLogs: (messageId: string) => ["request-logs", messageId] as const,
  harness: ["harness"] as const,
  workspaces: ["workspaces"] as const,
  rules: (threadId: string) => ["rules", threadId] as const,
  memories: ["memories"] as const,
  checkpoints: (threadId: string) => ["checkpoints", threadId] as const,
  processes: (threadId: string) => ["processes", threadId] as const,
  webSearch: ["websearch"] as const,
};

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api<Settings>("/settings") });
export const useCatalog = () => useQuery({ queryKey: keys.catalog, queryFn: () => api<CatalogResponse>("/catalog"), staleTime: Infinity });
export const useEndpoints = () => useQuery({ queryKey: keys.endpoints, queryFn: () => api<EndpointListResponse>("/endpoints") });
export const useModels = () => useQuery({ queryKey: keys.models, queryFn: () => api<ModelListResponse>("/models") });
export const useModelProfile = (id: string | null) =>
  useQuery({ queryKey: keys.profile(id ?? ""), queryFn: () => api<ModelProfileResponse>(`/models/${id}/profile`), enabled: !!id });
export const useThreadList = (mode: string) =>
  useQuery({ queryKey: keys.threads(mode), queryFn: () => api<ThreadListResponse>(`/threads?mode=${mode}`) });
export const useThread = (id: string | undefined) =>
  useQuery({ queryKey: keys.thread(id ?? ""), queryFn: () => api<ThreadDetailDto>(`/threads/${id}`), enabled: !!id });
export const useRequestLogs = (messageId: string | null) =>
  useQuery({ queryKey: keys.requestLogs(messageId ?? ""), queryFn: () => api<RequestLogResponse>(`/messages/${messageId}/request-logs`), enabled: !!messageId });

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (data) => qc.setQueryData(keys.settings, data),
  });
}

/** Invalidates everything that depends on the endpoint and model registry. */
export function useInvalidateRegistry() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.endpoints });
    void qc.invalidateQueries({ queryKey: keys.models });
    void qc.invalidateQueries({ queryKey: ["model-profile"] });
    void qc.invalidateQueries({ queryKey: keys.settings });
  };
}

export function modelLabel(m: { alias: string | null; name: string; modelId: string }): string {
  return m.alias ?? (m.name !== m.modelId ? m.name : m.modelId);
}

export const useHarness = () => useQuery({ queryKey: keys.harness, queryFn: () => api<HarnessListResponse>("/harness") });
export const useRecentWorkspaces = () => useQuery({ queryKey: keys.workspaces, queryFn: () => api<RecentWorkspacesResponse>("/workspaces/recent") });
export const useThreadRules = (threadId: string | undefined) =>
  useQuery({ queryKey: keys.rules(threadId ?? ""), queryFn: () => api<{ rules: ApprovalRuleDto[] }>(`/threads/${threadId}/rules`), enabled: !!threadId });

export const useMemories = () => useQuery({ queryKey: keys.memories, queryFn: () => api<MemoryListResponse>("/memories") });
export const useCheckpoints = (threadId: string | undefined) =>
  useQuery({ queryKey: keys.checkpoints(threadId ?? ""), queryFn: () => api<CheckpointListResponse>(`/threads/${threadId}/checkpoints`), enabled: !!threadId });
export const useProcesses = (threadId: string | undefined) =>
  useQuery({
    queryKey: keys.processes(threadId ?? ""),
    queryFn: () => api<{ processes: { id: string; command: string; running: boolean; exitCode: number | null; startedSeconds: number }[] }>(`/threads/${threadId}/processes`),
    enabled: !!threadId,
    refetchInterval: 5000,
  });
export const useWebSearch = () => useQuery({ queryKey: keys.webSearch, queryFn: () => api<WebSearchStatus>("/websearch") });
