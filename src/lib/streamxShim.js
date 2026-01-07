import streamx from 'streamx/index.js';

const mod = streamx && streamx.default ? streamx.default : streamx;

export const pipeline = mod.pipeline;
export const pipelinePromise = mod.pipelinePromise;
export const isStream = mod.isStream;
export const isStreamx = mod.isStreamx;
export const isEnded = mod.isEnded;
export const isFinished = mod.isFinished;
export const isDisturbed = mod.isDisturbed;
export const getStreamError = mod.getStreamError;
export const Stream = mod.Stream;
export const Writable = mod.Writable;
export const Readable = mod.Readable;
export const Duplex = mod.Duplex;
export const Transform = mod.Transform;
export const PassThrough = mod.PassThrough;

export default mod;
