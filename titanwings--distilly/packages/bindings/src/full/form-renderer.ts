import type { HostName } from "@distilly/protocol";

import type {
  HostContext,
  HostFormPresenter,
  HostFormRenderer,
  HostQuestion,
} from "../protocol.js";

/**
 * Creates the host-tagged renderer owned by one full binding.
 *
 * @param host - Host that owns the renderer.
 * @param context - Trusted active host context.
 * @param presenter - Outer trusted form presenter.
 * @returns Concrete renderer bound to the host and context.
 */
export const createHostFormRenderer = (
  host: HostName,
  context: HostContext,
  presenter: HostFormPresenter,
): HostFormRenderer =>
  Object.freeze({
    host,
    ask: <T extends HostQuestion>(question: T) => presenter.ask({ host, context, question }),
  });
