import { z } from "zod/v4";
import {
  ChatMessageRole,
  LLMApiKeySchema,
  logger,
  type PromptContent,
  ExperimentMetadataSchema,
  PromptContentSchema,
  DatasetRunItemUpsertQueue,
  ChatMessageType,
  type ChatMessage,
  PromptService,
  compileChatMessages,
  extractPlaceholderNames,
  type MessagePlaceholderValues,
  type PromptMessage,
} from "@langfuse/shared/src/server";
import { kyselyPrisma, prisma } from "@langfuse/shared/src/db";
import { type ExperimentCreateEventSchema } from "@langfuse/shared/src/server";
import {
  InvalidRequestError,
  LangfuseNotFoundError,
  type Prisma,
  extractVariables,
  datasetItemMatchesVariable,
  stringifyValue,
} from "@langfuse/shared";
import { backOff } from "exponential-backoff";
import { callLLM } from "../../features/utilities";
import { QueueJobs, redis } from "@langfuse/shared/src/server";
import { randomUUID } from "node:crypto";
import { v4 } from "uuid";
import { compileHandlebarString } from "../../features/utilities";
import { DatasetStatus } from "../../../../packages/shared/dist/prisma/generated/types";

const isValidPrismaJsonObject = (
  input: Prisma.JsonValue,
): input is Prisma.JsonObject =>
  typeof input === "object" &&
  input !== null &&
  input !== undefined &&
  !Array.isArray(input);

const replaceVariablesInPrompt = (
  prompt: PromptContent,
  itemInput: Record<string, any>,
  variables: string[],
): ChatMessage[] => {
  const processContent = (content: string) => {
    // Extract only relevant variables from itemInput
    const filteredContext = Object.fromEntries(
      Object.entries(itemInput).filter(([key]) => variables.includes(key)),
    );

    // Apply Handlebars ONLY if the content contains `{{variable}}` pattern
    if (content.includes("{{")) {
      return compileHandlebarString(content, filteredContext);
    }

    return content; // Return original content if no placeholders are found
  };

  if (typeof prompt === "string") {
    return [
      {
        role: ChatMessageRole.System,
        content: processContent(prompt),
        type: ChatMessageType.System as const,
      },
    ];
  }

  const placeholderNames = extractPlaceholderNames(prompt as PromptMessage[]);
  const placeholderValues: MessagePlaceholderValues = {};
  // itemInput to placeholderValues
  for (const placeholderName of placeholderNames) {
    if (!(placeholderName in itemInput)) {
      // TODO: handle missing placeholder values
      // throw new Error(`Missing placeholder value for '${placeholderName}'`);
      continue;
    }
    const value = itemInput[placeholderName];

    // for stringified arrays (e.g. from dataset processing)
    let actualValue = value;
    if (typeof value === 'string') {
      try {
        actualValue = JSON.parse(value);
      } catch (_e) {
        throw new Error(`Invalid placeholder value for '${placeholderName}': unable to parse JSON`);
      }
    }

    if (!Array.isArray(actualValue)) {
      throw new Error(`Placeholder '${placeholderName}' must be an array of messages`);
    }

    const validMessages = actualValue.every(msg =>
      typeof msg === 'object' &&
      msg !== null &&
      'role' in msg &&
      'content' in msg
    );
    if (!validMessages) {
      throw new Error(`Invalid placeholder value for '${placeholderName}': messages must have 'role' and 'content' properties`);
    }

    placeholderValues[placeholderName] = actualValue.map(msg => ({
      ...msg,
      type: ChatMessageType.PublicAPICreated as const,
    }));
  }

  const compiledMessages = compileChatMessages(
    prompt as PromptMessage[],
    placeholderValues,
    {}
  );

  // TODO: validate correctness
  // handlebars variable substitution to all messages
  return compiledMessages.map((message) => ({
    ...message,
    content: processContent(message.content),
    type: ChatMessageType.PublicAPICreated as const,
  }));
};

const validateDatasetItem = (
  itemInput: Prisma.JsonValue,
  variables: string[],
): itemInput is Prisma.JsonObject => {
  if (!isValidPrismaJsonObject(itemInput)) {
    return false;
  }
  return variables.some((variable) =>
    datasetItemMatchesVariable(itemInput, variable),
  );
};

const parseDatasetItemInput = (
  itemInput: Prisma.JsonObject,
  variables: string[],
): Prisma.JsonObject => {
  try {
    const filteredInput = Object.fromEntries(
      Object.entries(itemInput)
        .filter(([key]) => variables.includes(key))
        .map(([key, value]) => [
          key,
          value === null ? null : stringifyValue(value),
        ]),
    );
    return filteredInput;
  } catch (error) {
    logger.info("Error parsing dataset item input:", error);
    return itemInput;
  }
};

const fetchDatasetRun = async (datasetRunId: string, projectId: string) => {
  return await kyselyPrisma.$kysely
    .selectFrom("dataset_runs")
    .selectAll()
    .where("id", "=", datasetRunId)
    .where("project_id", "=", projectId)
    .executeTakeFirst();
};

const fetchPrompt = async (promptId: string, projectId: string) => {
  const promptService = new PromptService(prisma, redis);

  const rawPrompt = await prisma.prompt.findUnique({
    where: { id: promptId, projectId },
  });

  return promptService.resolvePrompt(rawPrompt);
};

export const createExperimentJob = async ({
  event,
}: {
  event: z.infer<typeof ExperimentCreateEventSchema>;
}) => {
  logger.info("Processing experiment create job", event);
  const { datasetId, projectId, runId } = event;

  /********************
   * INPUT VALIDATION *
   ********************/

  const datasetRun = await fetchDatasetRun(runId, projectId);
  if (!datasetRun) {
    throw new LangfuseNotFoundError(`Dataset run ${runId} not found`);
  }

  const validatedRunMetadata = ExperimentMetadataSchema.safeParse(
    datasetRun.metadata,
  );
  if (!validatedRunMetadata.success) {
    throw new InvalidRequestError(
      "Langfuse in-app experiments can only be run with prompt and model configurations in metadata.",
    );
  }

  const { prompt_id, provider, model, model_params } =
    validatedRunMetadata.data;
  const prompt = await fetchPrompt(prompt_id, projectId);

  if (!prompt) {
    throw new LangfuseNotFoundError(`Prompt ${prompt_id} not found`);
  }

  const validatedPrompt = PromptContentSchema.safeParse(prompt.prompt);
  if (!validatedPrompt.success) {
    throw new InvalidRequestError(
      `Prompt ${prompt_id} not found in expected format`,
    );
  }

  // fetch and validate API key
  const apiKey = await prisma.llmApiKeys.findFirst({
    where: {
      projectId: event.projectId,
      provider,
    },
  });
  if (!apiKey) {
    throw new LangfuseNotFoundError(
      `API key for provider ${provider} not found`,
    );
  }
  const validatedApiKey = LLMApiKeySchema.safeParse(apiKey);
  if (!validatedApiKey.success) {
    throw new InvalidRequestError(
      `API key for provider ${provider} not found.`,
    );
  }

  // fetch dataset items
  const datasetItems = await prisma.datasetItem.findMany({
    where: {
      datasetId,
      projectId,
      status: DatasetStatus.ACTIVE,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  // extract variables from prompt
  const extractedVariables = extractVariables(
    prompt?.type === "text"
      ? (prompt.prompt?.toString() ?? "")
      : JSON.stringify(prompt.prompt),
  );

  // also extract placeholder names if prompt is an array
  const placeholderNames = prompt?.type !== "text" && Array.isArray(validatedPrompt.data)
    ? extractPlaceholderNames(validatedPrompt.data as PromptMessage[])
    : [];
  const allVariables = [...extractedVariables, ...placeholderNames];

  // validate dataset items against prompt configuration
  const validatedDatasetItems = datasetItems
    .filter(({ input }) => validateDatasetItem(input, allVariables))
    .map((datasetItem) => ({
      ...datasetItem,
      input: parseDatasetItemInput(
        datasetItem.input as Prisma.JsonObject, // this is safe because we already filtered for valid input
        allVariables,
      ),
    }));

  if (!validatedDatasetItems.length) {
    throw new InvalidRequestError(
      `No Dataset ${datasetId} item input matches expected prompt variable format`,
    );
  }

  for (const datasetItem of validatedDatasetItems) {
    // dedupe and skip if dataset run item already exists
    const existingRunItem = await kyselyPrisma.$kysely
      .selectFrom("dataset_run_items")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("dataset_item_id", "=", datasetItem.id)
      .where("dataset_run_id", "=", runId)
      .executeTakeFirst();

    if (existingRunItem) {
      logger.info(
        `Dataset run item ${existingRunItem.id} already exists, skipping`,
      );
      continue;
    }

    /********************
     * VARIABLE EXTRACTION *
     ********************/

    let messages: ChatMessage[] = [];
    try {
      messages = replaceVariablesInPrompt(
        validatedPrompt.data,
        datasetItem.input, // validated format
        extractedVariables,
      );
    } catch (error) {
      // skip this dataset item if there is an error replacing variables
      logger.error(
        `Error replacing variables in prompt for dataset item ${datasetItem.id}`,
        error,
      );
      continue;
    }

    /********************
     * RUN ITEM CREATION *
     ********************/

    const newTraceId = v4();

    const runItem = await prisma.datasetRunItems.create({
      data: {
        datasetItemId: datasetItem.id,
        traceId: newTraceId,
        datasetRunId: runId,
        projectId,
      },
    });

    /********************
     * LLM MODEL CALL *
     ********************/

    const traceParams = {
      tags: ["langfuse-prompt-experiment"], // LFE-2917: filter out any trace in trace upsert queue that has this tag set
      traceName: `dataset-run-item-${runItem.id.slice(0, 5)}`,
      traceId: newTraceId,
      projectId: event.projectId,
      authCheck: {
        validKey: true as const,
        scope: {
          projectId: event.projectId,
          accessLevel: "project",
        } as any,
      },
    };

    await backOff(
      async () =>
        await callLLM(
          validatedApiKey.data,
          messages,
          model_params,
          provider,
          model,
          traceParams,
        ),
      {
        numOfAttempts: 1, // turn off retries as Langchain is doing that for us already.
      },
    );

    /********************
     * ASYNC RUN ITEM EVAL *
     ********************/

    if (redis) {
      const queue = DatasetRunItemUpsertQueue.getInstance();
      if (queue) {
        await queue.add(QueueJobs.DatasetRunItemUpsert, {
          payload: {
            projectId,
            datasetItemId: datasetItem.id,
            traceId: newTraceId,
          },
          id: randomUUID(),
          timestamp: new Date(),
          name: QueueJobs.DatasetRunItemUpsert as const,
        });
      }
    }
  }
};
