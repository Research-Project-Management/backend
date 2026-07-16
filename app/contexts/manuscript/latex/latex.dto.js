import { z } from "zod";

export const SyncIncrementalDto = {
  body: z.object({
    dirtyFileIds: z.array(z.string()).optional(),
    forceAll: z.boolean().optional(),
  }),
};
