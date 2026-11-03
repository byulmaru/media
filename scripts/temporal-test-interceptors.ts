import {
  condition,
  defineSignal,
  setHandler,
  type WorkflowInterceptors,
} from "@temporalio/workflow";
import { PUBLISH_UPLOAD_V2_RESULT_SIGNAL_NAME } from "../src/temporal/types";

const failingCallerWorkflowIdPrefix = "publish-v2-hope-failure:";
const releaseReplyGateSignal = "releasePublishUploadV2ReplyTestGate";

export function interceptors(): WorkflowInterceptors {
  let replyGateReleased = false;
  return {
    outbound: [{
      async signalWorkflow(input, next) {
        const reply = input.args[0] as { result?: { status?: string } } | undefined;
        if (
          input.signalName === PUBLISH_UPLOAD_V2_RESULT_SIGNAL_NAME &&
          input.target.type === "external" &&
          input.target.workflowExecution.workflowId.startsWith(failingCallerWorkflowIdPrefix) &&
          reply?.result?.status === "processing"
        ) {
          setHandler(defineSignal(releaseReplyGateSignal), () => { replyGateReleased = true; });
          await next(input);
          await condition(() => replyGateReleased);
          return;
        }
        await next(input);
      },
    }],
  };
}
