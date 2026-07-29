/**
 * Compatibility aliases for existing knowledge hooks.
 *
 * Request state is domain-neutral; these names remain private compatibility
 * aliases so the existing knowledge hooks do not change behavior in this slice.
 */
export {
  isAbortError,
  useRequestMutation as useKnowledgeMutation,
  useRequestQuery as useKnowledgeQuery,
} from "./useRequest.js";
