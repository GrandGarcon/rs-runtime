import { config } from "../config.ts";

//import { zip } from "../pipeline/zipJoiner";
import { jsonObject } from "./jsonObjectJoiner.ts";
//import { unzip } from "../pipeline/unzipSplitter";
//import { multipartSplit } from "../pipeline/multipartSplitSplitter";
//import { jsonSplit } from "../pipeline/jsonSplitSplitter";
import { Message } from "rs-core/Message.ts";
import { MessageFunction } from "rs-core/Service.ts";
import { AsyncQueue } from "rs-core/utility/asyncQueue.ts";
//import { multipart } from "./multipartJoiner";
import { PipelineStep } from "./pipelineStep.ts";
import { PipelineAction, PipelineMode } from "./pipelineMode.ts";
import { pipelineInitializerIntoContext } from "./pipelineInitializer.ts";
import { PipelineTransform } from "./pipelineTransform.ts";
import { Url } from "rs-core/Url.ts";
import { PipelineContext } from "./pipelineContext.ts";
import { handleOutgoingRequest } from "../handleRequest.ts";
import { PipelineSpec } from "rs-core/PipelineSpec.ts";

type PipelineElement = PipelineSpec | PipelineOperator | PipelineStep | PipelineMode | PipelineTransform;

enum PipelineElementType {
    parallelizer, serializer, subpipeline, step, mode, initializer, transform
}

enum PipelineParallelizer {
    dup, split, unzip, jsonSplit
}

enum PipelineSerializer {
    jsonObject, zip, multipart
}

type PipelineOperator = PipelineParallelizer | PipelineSerializer | Partial<PipelineContext>;

function parsePipelineElement(el: string | Record<string, unknown> | PipelineSpec): [ PipelineElementType | null, PipelineElement | null] {
    if (Array.isArray(el)) {
        return [ PipelineElementType.subpipeline, el ];
    } else if (typeof el === 'object') {
        return PipelineTransform.isValid(el)
            ? [ PipelineElementType.transform, new PipelineTransform(el) ]
            : [ null, null ];
    } else {
        el = el.trim();
        if (PipelineMode.isValid(el)) return [ PipelineElementType.mode, new PipelineMode(el) ];
        if ((PipelineParallelizer as any)[el] !== undefined) return [ PipelineElementType.parallelizer,  (PipelineParallelizer as any)[el] ];
        if ((PipelineSerializer as any)[el] !== undefined) return [ PipelineElementType.serializer, (PipelineSerializer as any)[el] ];
        const initializerContext = pipelineInitializerIntoContext(el);
        if (initializerContext) return [ PipelineElementType.initializer, initializerContext ];
        try {
            return [ PipelineElementType.step, new PipelineStep(el) ];
        } catch {
            return [ null, null ];
        }
    }
}

function testPipeline(pipeline: PipelineSpec, msg: Message, mode: PipelineMode, context: PipelineContext): boolean {
    if (pipeline.length === 0) return false;
    for (const item of pipeline) {
        const [elType, el] = parsePipelineElement(item);
        if (elType == PipelineElementType.step) {
                return (el as PipelineStep).test(msg, mode, context);
        }
    }
    return true;
}

function runPipeline(pipeline: PipelineSpec, msgs: AsyncQueue<Message>, parentMode: PipelineMode, context: PipelineContext): AsyncQueue<Message> {
    return msgs.flatMap(msg => runPipelineOne(pipeline, msg, parentMode, context));
}

function processStepSucceeded(mode: PipelineMode, endedMsgs: Message[], stepResult: Promise<Message | AsyncQueue<Message>>) {
    if (mode.succeed === PipelineAction.end) {
        return stepResult.then(msg_s => {
            if (msg_s instanceof AsyncQueue) {
                return msg_s.flatMap(msg => {
                    endedMsgs.push(msg);
                    return msg;
                })
            } else {
                endedMsgs.push(msg_s);
                return msg_s;
            }
        });
    } else {
        return stepResult.then(msg_s => {
            // end message if it's an error
            if (msg_s instanceof Message && (msg_s.isRedirect || !msg_s.ok)) {
                endedMsgs.push(msg_s);
            }
            return msg_s;
        });
    }
}

function processStepFailed(mode: PipelineMode, endedMsgs: Message[], msg: Message) {
    if (mode.fail === PipelineAction.stop) {
        return null;
    } else if (mode.fail === PipelineAction.next) {
        return msg;
    } else if (mode.fail === PipelineAction.end) {
        endedMsgs.push(msg);
        return msg;
    }
}

// Run a pipeline
function runPipelineOne(pipeline: PipelineSpec, msg: Message, parentMode: PipelineMode, context: PipelineContext): AsyncQueue<Message> {
    let mode = new PipelineMode(parentMode); // default subpipeline of serial pipeline is parallel & v-a-v
    // check for initial mode specifier
    const [ elType, el ] = parsePipelineElement(pipeline[0]);
    if (elType == PipelineElementType.mode) {
        mode = el as PipelineMode;
        pipeline = pipeline.slice(1);
    }
    
    if (mode.mode == "parallel") {
        // pipeline is parallel
        return runDistributePipelineOne(pipeline, msg, context);
    }

    // pipeline is serial

    let pos = 0;
    let msgs = new AsyncQueue<Message>(1).enqueue(msg);
    const endedMsgs: Message[] = [];

    while (pos < pipeline.length) {
        try {
            const [ elType, el ] = parsePipelineElement(pipeline[pos]);
            let succeeded = false;
            switch (elType) {
                case PipelineElementType.mode: {
                    const newMode = el as PipelineMode;
                    if (!mode.allowedMidstreamChangeTo(newMode)) throw new Error('Cannot change in midstream to mode ' + newMode.toString());
                    mode = newMode;
                    break;
                }
                case PipelineElementType.step: {
                    const step = el as PipelineStep;
                    const fixedMode = mode;
                    msgs = msgs.flatMap(msg => {
                        if (endedMsgs.includes(msg)) return msg;
                        succeeded = step.test(msg, fixedMode, context);
                        if (succeeded) {
                            const stepResult = step.execute(msg, context);
                            if (!stepResult) return null;
                            return processStepSucceeded(fixedMode, endedMsgs, stepResult);
                        } else {
                            return processStepFailed(fixedMode, endedMsgs, msg);
                        }
                    });
                    if (step.tryMode) { // set conditional mode on pipeline
                        mode = new PipelineMode("conditional");
                    }
                    break;
                }
                case PipelineElementType.transform: {
                    const transform = el as PipelineTransform;
                    msgs = msgs.flatMap(msg => transform.execute(msg));
                    break;
                }
                case PipelineElementType.subpipeline: {
                    const fixedModeSubpipeline = mode;
                    
                    msgs = msgs.flatMap(msg => {
                        if (endedMsgs.includes(msg)) return msg;
                        succeeded = testPipeline(el as PipelineSpec, msg, fixedModeSubpipeline, context);
                        if (succeeded) {
                            const stepResult = runPipeline(el as PipelineSpec, new AsyncQueue<Message>(1).enqueue(msg), mode, context);
                            return processStepSucceeded(fixedModeSubpipeline, endedMsgs, Promise.resolve(stepResult));
                        } else {
                            return processStepFailed(fixedModeSubpipeline, endedMsgs, msg);
                        }
                    });
                    break;
                }
                case PipelineElementType.parallelizer: {
                    // const op = el as PipelineParallelizer;
                    // switch (op) {
                    //     case PipelineParallelizer.unzip:
                    //         msgs = msgs.flatMap(msg => unzip(msg));
                    //         break;
                    //     case PipelineParallelizer.split:
                    //         msgs = msgs.flatMap(msg => multipartSplit(msg));
                    //         break;
                    //     case PipelineParallelizer.jsonSplit:
                    //         msgs = msgs.flatMap(msg => jsonSplit(msg));
                    //         break;
                    // }
                    break;
                }
                case PipelineElementType.serializer:
                    switch (el) {
                        // case PipelineSerializer.zip:
                        //     msgs = AsyncQueue.fromPromises(zip(msgs));
                        //     break;
                        case PipelineSerializer.jsonObject:
                            msgs = AsyncQueue.fromPromises(jsonObject(msgs));
                            break;
                        // case PipelineSerializer.multipart:
                        //     msgs = AsyncQueue.fromPromises(multipart(msgs));
                        //     break;
                    }
                    break;
                default:
                    throw new Error(`unrecognized pipeline element ${JSON.stringify(pipeline[pos])}`);
            }
        } catch (err) {
            config.logger.error(`pipeline error stage = '${pipeline[pos]}': ${err}`);

            return msgs.flatMap(() => err as Error);
        }
        //if (!currMsg.ok) return currMsg;
        pos++;
    }
    return msgs.flatMap(msg =>
        msg.exitConditionalMode()); // at end of pipeline, any messages in test mode should return to normal
}

function runDistributePipelineOne(pipeline: PipelineSpec, msg: Message, context: PipelineContext): AsyncQueue<Message> {
    let pos = 0;
    const msgs = new AsyncQueue<Message>(pipeline.length);
    while (pos < pipeline.length) {
        try {
            const [ elType, el ] = parsePipelineElement(pipeline[pos]);
            const newMsg = msg.copyWithData();
            let succeeded = false;
            switch (elType) {
                case PipelineElementType.step: {
                    const step = el as PipelineStep;
                    succeeded = step.test(newMsg, PipelineMode.parallel(), context);
                    if (succeeded) {
                        //newMsg = rename(newMsg, fixedPos);
                        const stepResult = step.execute(newMsg, context);
                        msgs.enqueue(stepResult);
                    } else {
                        msgs.enqueue(null);
                    }
                    break;
                }
                case PipelineElementType.subpipeline:
                    succeeded = testPipeline(el as PipelineSpec, newMsg, PipelineMode.parallel(), context);
                    if (succeeded) {
                        const msgsOut = runPipeline(el as PipelineSpec, new AsyncQueue<Message>(1).enqueue(newMsg), new PipelineMode("parallel"), context);
                        //msgs.enqueue(rename(msgsOut, fixedPos));
                        msgs.enqueue(msgsOut);
                    } else {
                        msgs.enqueue(null);
                    }
                    break;
                case PipelineElementType.transform: {
                    const transform = el as PipelineTransform;
                    msgs.enqueue(transform.execute(msg));
                    break;
                }
                default:
                    throw new Error('No operators allowed in parallel sub pipeline');
            }
        } catch (err) {
            msgs.close();
            config.logger.error(`pipeline error stage = '${pipeline[pos]}' ${err}`);
            return new AsyncQueue<Message>(1).enqueue(err as Error);
        }
        pos++;
    }
    return msgs;
}

function createInitialContext(pipeline: PipelineSpec, handler: MessageFunction, callerMsg: Message, contextUrl?: Url, external?: boolean): [ PipelineContext, PipelineSpec ] {
    const context = {
        handler,
        callerUrl: contextUrl || callerMsg.url,
        callerMethod: callerMsg.method,
        external
    } as PipelineContext;
    let stepIdx = 0;
    for (; stepIdx < pipeline.length; stepIdx++) {
        const [ elType, el ] = parsePipelineElement(pipeline[stepIdx]);
        if (elType !== PipelineElementType.initializer) break;
        Object.assign(context, el as Partial<PipelineContext>);
    }
    if (context.targetHost) {
        context.targetHeaders = {};
        if (callerMsg.getHeader('authorization')) {
            context.targetHeaders['authorization'] = callerMsg.getHeader('authorization');
        }
    } else {
        context.targetHost = new Url();
        context.targetHost.domain = callerMsg.url.domain;
        context.targetHost.scheme = callerMsg.url.scheme;
    }
    return [ context, pipeline.slice(stepIdx) ];
}

export async function pipeline(msg: Message, pipeline: PipelineSpec, contextUrl?: Url, external?: boolean, handler: MessageFunction = handleOutgoingRequest) {
    const [ context, mainPipeline ] = createInitialContext(pipeline, handler, msg, contextUrl, external);
    const asq = runPipeline(mainPipeline, new AsyncQueue<Message>(1).enqueue(msg), new PipelineMode("parallel"), context);

    // const outMsg = !asq.nRemaining || asq.nRemaining <= 1
    //     ? (await asq.next()).value
    //     : (await multipart(asq));
    const outMsg = (await asq.next()).value;
    outMsg.url = msg.url;
    Object.assign(outMsg.headers, context.outputHeaders || {});
    return outMsg || msg.copy().setStatus(204, '');
}