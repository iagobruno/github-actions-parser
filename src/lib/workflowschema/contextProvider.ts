import { getEventPayload } from "../events/eventPayload";
import { replaceExpressions } from "../expressions";
import { containsExpression } from "../expressions/embedding";
import { Undetermined } from "../expressions/functions";
import { ContextProvider, DynamicContext } from "../expressions/types";
import { mergeDeep } from "../utils/deepMerge";
import { iteratePath, PropertyPath } from "../utils/path";
import { Job, Step, Workflow } from "../workflow";

function getEvent(workflow: Workflow) {
  if (workflow && workflow.on) {
    const events = Object.keys(workflow.on);
    const eventPayload = getEventPayload(events);

    // Add dynamic properties
    if (workflow?.on.workflow_dispatch) {
      eventPayload["inputs"] = {};

      for (const inputName of Object.keys(
        workflow.on.workflow_dispatch.inputs || {}
      )) {
        eventPayload["inputs"][inputName] =
          workflow.on.workflow_dispatch.inputs![inputName]?.default ||
          "<provided input>";
      }
    }

    return eventPayload;
  }

  // Default to push, since it's one of the most common payloads
  return getEventPayload(["push"]);
}

function getJob(workflow: Workflow, path: PropertyPath): Job | undefined {
  const jobsIdx = path.indexOf("jobs");
  if (jobsIdx === -1) {
    return;
  } else if (jobsIdx >= path.length - 2) {
    return;
  }

  // [$, jobs, build, [steps, 0]]
  return iteratePath(path.slice(0, jobsIdx + 2), workflow) as Job;
}

export class EditContextProvider implements ContextProvider {
  constructor(
    private workflow: Workflow,
    private path: PropertyPath,
    private secrets: string[] | typeof DynamicContext
  ) {}

  get(
    context:
      | "github"
      | "env"
      | "job"
      | "steps"
      | "runner"
      | "secrets"
      | "strategy"
      | "matrix"
      | "needs"
  ): Object {
    switch (context) {
      case "github":
        return {
          event: getEvent(this.workflow),
          event_path: "",
          workflow: this.workflow?.name || "workflow.yaml",
          job: "",
          run_id: "42",
          run_number: "23",
          actor: "monalisa",
          repository: "repository",
          repository_owner: "repository_owner",
          event_name:
            (this.workflow?.on && Object.keys(this.workflow.on)[0]) || "push",
          sha: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
          ref: "main",
          head_ref: "refs/heads/branch",
          base_ref: "refs/heads/main",
          token: "***",
          workspace: "",
          action: "",
          action_path: "",
        };

      case "env":
        let env = {};

        if (this.workflow) {
          iteratePath(this.path, this.workflow, (x) => {
            if (x["env"]) {
              const newEnv = {
                ...x["env"],
              };

              for (const key of Object.keys(newEnv)) {
                const value = newEnv[key];
                if (containsExpression(value)) {
                  try {
                    newEnv[key] = replaceExpressions(value, {
                      get: (context) => {
                        if (context === "env") {
                          return env;
                        }

                        return this.get(context);
                      },
                    });
                  } catch (e) {
                    // This is best effort, leave the expression as value
                  }
                }
              }

              env = {
                ...env,
                ...newEnv,
              };
            }
          });
        }

        return env;

      case "runner": {
        return {
          os: "macOS",
          temp: "/tmp",
          tool_cache: "/tmp/cache",
        };
      }

      case "job": {
        const job = getJob(this.workflow, this.path);
        if (!job) {
          return {};
        }

        return {
          status: "success",
          container: {
            id: "",
            network: "",
          },
          services: job.services,
        };
      }

      case "needs": {
        const job = getJob(this.workflow, this.path);
        if (!job) {
          return {};
        }

        return (
          job.needs?.reduce((r, jobId) => {
            const outputs: { [key: string]: any } =
              this.workflow.jobs[jobId].outputs || {};

            for (const output of Object.keys(outputs)) {
              if (containsExpression(outputs[output])) {
                // If the output reference another expression, mark it as undetermined for now.
                outputs[output] = Undetermined;
              }
            }

            return {
              ...r,
              [jobId]: {
                result: "success",
                outputs,
              },
            };
          }, {}) || {}
        );
      }

      case "matrix": {
        const job = getJob(this.workflow, this.path);
        if (!job) {
          return {};
        }

        if (job.strategy?.matrix) {
          if (typeof job.strategy.matrix === "string" /* Expression */) {
            // Matrix is an expression, mark this as a dynamic context. Currently we cannot reason about those
            return DynamicContext;
          }

          // Merge all values to all invocations. Not all of them will be available all the time, but for
          // validation (and completion) purposes this is good enough
          return mergeDeep({}, ...job.strategy.matrix);
        }

        return {};
      }

      case "strategy": {
        const job = getJob(this.workflow, this.path);
        return job?.strategy || {};
      }

      case "steps": {
        // Check if we are in a step
        const stepsIdx = this.path
          .map((x) => (Array.isArray(x) ? x[0] : x))
          .indexOf("steps");
        if (stepsIdx === -1) {
          return {};
        }

        // Find the current job
        const job = getJob(this.workflow, this.path);
        if (!job) {
          return {};
        }

        // Find the current step
        const step = iteratePath(
          this.path.slice(0, stepsIdx + 1),
          this.workflow
        ) as Step;

        const stepIdx = job.steps.indexOf(step);
        if (stepIdx === -1) {
          return {};
        }

        // Iterate over all previous steps
        return job.steps.slice(0, stepIdx + 1).reduce(
          (r, step, stepIdx) => ({
            ...r,
            [step.id || `${stepIdx}`]: {
              outputs: DynamicContext, // They might come from an action, we cannot determine those
              outcome: "success",
              conclusion: "success",
            },
          }),
          {}
        );
      }

      case "secrets":
        if (!Array.isArray(this.secrets)) {
          return DynamicContext;
        }

        return this.secrets.reduce((s, name) => {
          s[name] = "***";
          return s;
        }, {});
    }
  }
}
