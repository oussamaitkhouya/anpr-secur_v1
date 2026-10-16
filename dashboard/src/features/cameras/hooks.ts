import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { registry } from "./api";
import type { CameraCredentials, CameraDraft, CameraPatch, CameraRegistryApi } from "./types";

export const keys = {
  cities: ["registry", "cities"] as const,
  cameras: ["registry", "cameras"] as const,
  history: (id: string) => ["registry", "history", id] as const,
  audit: (id: string) => ["registry", "audit", id] as const,
};

export function useCities(api: CameraRegistryApi = registry) {
  return useQuery({ queryKey: keys.cities, queryFn: () => api.listCities() });
}

export function useCameras(api: CameraRegistryApi = registry) {
  return useQuery({ queryKey: keys.cameras, queryFn: () => api.listCameras() });
}

export function useStatusHistory(id: string | null, api: CameraRegistryApi = registry) {
  return useQuery({ queryKey: keys.history(id ?? ""), queryFn: () => api.statusHistory(id!), enabled: !!id });
}

/** Audit entries need audit.read (admins); others get no query at all. */
export function useCameraAudit(id: string | null, enabled: boolean, api: CameraRegistryApi = registry) {
  return useQuery({ queryKey: keys.audit(id ?? ""), queryFn: () => api.cameraAudit(id!), enabled: !!id && enabled });
}

export function useRegistryMutations(api: CameraRegistryApi = registry) {
  const qc = useQueryClient();
  const refresh = (id?: string) => {
    void qc.invalidateQueries({ queryKey: keys.cameras });
    void qc.invalidateQueries({ queryKey: keys.cities });
    if (id) {
      void qc.invalidateQueries({ queryKey: keys.history(id) });
      void qc.invalidateQueries({ queryKey: keys.audit(id) });
    }
  };
  return {
    createCity: useMutation({ mutationFn: (v: { name: string; region: string }) => api.createCity(v), onSuccess: () => refresh() }),
    updateCity: useMutation({
      mutationFn: (v: { id: string; name: string; region: string }) => api.updateCity(v.id, { name: v.name, region: v.region }),
      onSuccess: () => refresh(),
    }),
    deleteCity: useMutation({ mutationFn: (id: string) => api.deleteCity(id), onSuccess: () => refresh() }),
    createCamera: useMutation({ mutationFn: (v: CameraDraft) => api.createCamera(v), onSuccess: (c) => refresh(c.id) }),
    updateCamera: useMutation({
      mutationFn: (v: { id: string; patch: CameraPatch }) => api.updateCamera(v.id, v.patch),
      onSuccess: (c) => refresh(c.id),
    }),
    deleteCamera: useMutation({ mutationFn: (id: string) => api.deleteCamera(id), onSuccess: () => refresh() }),
    replaceCredentials: useMutation({
      mutationFn: (v: { id: string; credentials: CameraCredentials }) => api.replaceCredentials(v.id, v.credentials),
      onSuccess: (_r, v) => refresh(v.id),
    }),
    testConnection: useMutation({ mutationFn: (id: string) => api.testConnection(id), onSuccess: (_r, id) => refresh(id) }),
  };
}
