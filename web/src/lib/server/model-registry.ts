export abstract class ModelRegistry<ModelT, ModelFilesT> {
	abstract listRemoteModels(): AsyncIterable<ModelT>;
	abstract listLocalModels(): AsyncIterable<ModelT>;
	abstract getModel(modelId: string): Promise<ModelT>;
	abstract getModelFiles(modelId: string): Promise<ModelFilesT>;
	abstract downloadModelFiles(modelId: string): Promise<void>;

	async downloadModelFilesIfNotExist(modelId: string): Promise<boolean> {
		try {
			await this.getModelFiles(modelId);
			return false;
		} catch {
			await this.downloadModelFiles(modelId);
			return true;
		}
	}
}
