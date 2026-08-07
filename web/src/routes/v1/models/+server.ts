import type { RequestHandler } from './$types';
import { modelTaskSchema } from '$lib/types/api';
import { listLocalModelsByTask } from '$lib/server/model-catalog';

export const GET: RequestHandler = async ({ url }) => {
	const rawTask = url.searchParams.get('task');
	const parsedTask = rawTask === null ? undefined : modelTaskSchema.safeParse(rawTask);
	if (parsedTask !== undefined && !parsedTask.success) {
		return Response.json(
			{
				detail: [
					{
						type: 'enum',
						loc: ['query', 'task'],
						msg: `Unsupported model task: ${rawTask}`,
						input: rawTask
					}
				]
			},
			{ status: 422 }
		);
	}

	const task = parsedTask?.success ? parsedTask.data : undefined;
	return Response.json({ data: await listLocalModelsByTask(task), object: 'list' });
};
