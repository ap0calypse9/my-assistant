import { logger, task } from "@trigger.dev/sdk";
export const helloWorldTask = task({
    id: "hello-world",
    maxDuration: 300,
    run: async (payload) => {
        const name = payload.name ?? "world";
        logger.log(`Hello, ${name}!`);
        return {
            message: `Hello, ${name}!`,
        };
    },
});
