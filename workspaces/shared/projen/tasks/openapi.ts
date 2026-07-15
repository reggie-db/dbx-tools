#!/usr/bin/env -S npx tsx
import { generateOpenapi } from "../src/openapi";
import { runSynth } from "../src/scaffold";

const dirs = await generateOpenapi();
if (dirs.length > 0) runSynth({ post: true });
