export const useData = () => ({ location: { integration: { list: () => [] } } })
export const useWorkspaceLocation = () => () => ({ directory: "/fixture", ref: {directory: "/fixture"} })
export const useServer = () => ({ key: "sidecar", conn: {type: "sidecar", variant: "base"} })
