import { Service } from "rs-core/Service.ts";
import { IServiceConfig } from "rs-core/IServiceConfig.ts";
import { IDataAdapter } from "rs-core/adapter/IDataAdapter.ts";
import { Message, MessageMethod } from "rs-core/Message.ts";
import { sign_detached_verify } from "https://cdn.jsdelivr.net/gh/intob/tweetnacl-deno@1.1.0/src/sign.ts";
import { hex2array, pathCombine, upTo } from "rs-core/utility/utility.ts";
import { DirDescriptor, PathInfo, StoreSpec } from "rs-core/DirDescriptor.ts";
import { MessageBody } from "rs-core/MessageBody.ts";

interface IDiscordConfig extends IServiceConfig {
	applicationId: string;
	botToken: string; 
	publicKey: string; 
	guildIds?: string[];
}

const service = new Service<IDataAdapter, IDiscordConfig>();

const discordBaseUrl = "https://discord.com/api/v8";

const commandSchema = {
	type: "object",
	properties: {
		id: { type: "string", readOnly: true },
		type: { type: "number", enum: [ 1, 2, 3 ], enumText: [ "Chat Input (slash command)", "User (rt click a user)", "Message (rt click a message)" ] },
		name: { type: "string", description: "Name of the command", maxLength: 32 },
		description: { type: "string", maxLength: 100 },
		default_permission: { type: "boolean" },
		version: { type: "string", readOnly: true },
		options: { type: "array",
			items: {
				type: "object",
				properties: {
					type: { type: "number", enum: [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 ], enumText: [
						"Subcommand",
						"Subcommand Group",
						"String",
						"Integer",
						"Boolean",
						"User",
						"Channel",
						"Role",
						"Mentionable",
						"Number",
						"Attachment"
					 ] },
					name: { type: "string", maxLength: 32 },
					description: { type: "string", maxLength: 100 },
					required: { type: "boolean" },
					choices: {
						type: "object",
						properties: {
							name: { type: "string" },
							value: { type: "string" }
						}
					},
					channel_types: { type: "array",
						items: {
							type: "number",
							enum: [ 0, 1, 2, 3, 4, 5, 6, 13 ],
							enumText: [
								"Guild text",
								"DM",
								"Guild voice",
								"Group DM",
								"Guild category",
								"Guild news",
								"Guild store",
								"Guild stage voice"
							]
						}
					},
					min_value: { type: "number" },
					max_value: { type: "number" },
					autocomplete: { type: "boolean" }
				},
				required: [ "type", "name", "description" ]
			}
		}
	},
	required: [ "name", "description" ],
	pathPattern: '${name}|${id}'
};

const verify = async (msg: Message, config: IDiscordConfig) => {
	const signature = msg.getHeader('X-Signature-Ed25519');
	const timestamp = msg.getHeader('X-Signature-Timestamp');
	const body = await msg.data?.asString();
	const enc = new TextEncoder();
	const isVerified = sign_detached_verify(
		enc.encode(timestamp + body),
		hex2array(signature),
		hex2array(config.publicKey)
	);
	return isVerified;
}

const getRequest = (path: string, method: MessageMethod, tenant: string, config: IDiscordConfig) => {
	const msg = new Message(pathCombine(discordBaseUrl, `applications/${config.applicationId}`, path), tenant, method);
	msg.setHeader("Authorization", "Bot " + config.botToken);
	msg.setHeader("User-Agent", "DiscordBot (https://restspace.io, 0.1)");
	return msg;
}

const snowflakeToTimestamp = (snf: string) => {
	const snfi = Number(BigInt(snf) >> 22n);
	return snfi + 1420070400000;
}

const commandSchemaMimeType = (baseUrl: string) => {
	const schemaUrl = pathCombine(baseUrl, "command/.schema.json");
	return `application/json; schema="${schemaUrl}"`;
}

// service.post(async (msg, _context, config) => {

// });

// incoming interaction from Discord
service.postPath("interaction", async (msg, _context, config) => {
	if (!await verify(msg, config)) {
		console.log('Invalid');
		return msg.setStatus(401, 'invalid request signature');
	}
	const json = await msg.data?.asJson();
	if (json.type === 1) {
		console.log('PING');
		return msg.setDataJson({ type: 1 }).setStatus(200);
	}
	console.log('interaction:' + json.type);
	return msg;
});

service.getPath("command/.schema.json", (msg) =>
	Promise.resolve(msg.setDataJson(commandSchema, "application/schema+json")));

const processArgs = (msg: Message): [ string, string ] | string => {
	const scope = msg.url.servicePathElements[0];
	let nameId = msg.url.servicePathElements[1];
	if (nameId.endsWith('.json')) nameId = nameId.slice(0, -5);
	if (!scope) return 'no scope for command';
	if (!/^(global|[0-9]{18})$/.test(scope)) return 'scope not 18 digit snowflake id or "global"';
	if (!nameId) return 'missing command name-id';
	const [ _, id ] = decodeURIComponent(nameId).split('|');
	if (id && !/^[0-9]{18}$/.test(id)) return 'id part of resource is present but not 18 digit snowflake id';
	return [ scope, id?.trim() ];
}

service.getPath("command", async (msg, context, config) => {
	const processed = processArgs(msg);
	if (!Array.isArray(processed)) return msg.setStatus(400, processed);
	const [ scope, id ] = processed;

	let req: Message;
	if (scope === 'global') {
		req = getRequest(`commands/${id}`, "GET", context.tenant, config);
	} else {
		req = getRequest(`guilds/${scope}/commands/${id}`, "GET", context.tenant, config);
	}

	const resp = await context.makeRequest(req);
	if (!resp.ok) {
		const _err = await resp.data?.asString();
		return resp;
	}
	resp.data!.mimeType = commandSchemaMimeType(upTo(msg.url.baseUrl(), "/command"));
	return resp;
});

service.putPath("command", async (msg, context, config) => {
	const processed = processArgs(msg);
	if (!Array.isArray(processed)) return msg.setStatus(400, processed);
	const [ scope, id ] = processed;

	let req: Message;
	if (scope === 'global') {
		if (!id?.trim()) {
			req = getRequest(`commands`, "POST", context.tenant, config);
		} else {
			req = getRequest(`commands/${id}`, "PATCH", context.tenant, config);
		}
	} else {
		if (!id?.trim()) {
			req = getRequest(`guilds/${scope}/commands`, "POST", context.tenant, config);
		} else {
			req = getRequest(`guilds/${scope}/commands/${id}`, "PATCH", context.tenant, config);
		}
	}
	req.data = msg.data;
	const resp = await context.makeRequest(req);
	if (!resp.ok) {
		const _err = await resp.data?.asString();
		return resp;
	}
	resp.data = undefined;
	return resp;
}, commandSchema);

service.deletePath("command", async (msg, context, config) => {
	const processed = processArgs(msg);
	if (!Array.isArray(processed)) return msg.setStatus(400, processed);
	const [ scope, id ] = processed;

	let req: Message;
	if (scope === 'global') {
		req = getRequest(`commands/${id}`, "DELETE", context.tenant, config);
	} else {
		req = getRequest(`guilds/${scope}/commands/${id}`, "DELETE", context.tenant, config);
	}
	const resp = await context.makeRequest(req);
	if (!resp.ok) {
		const _err = await resp.data?.asString();
		return resp;
	}
	resp.data = undefined;
	return resp;
});

service.getDirectory(async (msg, context, config) => {
	let reqType: "top" | "command" | "permission" | "global" | "guild" = "top";
	const typeEl = msg.url.servicePathElements[0];
	const scopeEl = msg.url.servicePathElements[1];
	if (typeEl) {
		reqType = typeEl === "command" ? "command" : "permission";
		if (scopeEl) {
			reqType = scopeEl === "global" ? "global" : "guild";
		}
	}

	const dirDesc: DirDescriptor = {
		path: msg.url.servicePath,
		paths: []
	};
	
	const spec: StoreSpec = {
		pattern: "store",
		storeMimeTypes: [ commandSchemaMimeType(msg.url.baseUrl()) ],
		createDirectory: false,
		createFiles: true
	}

	switch (reqType) {
		case "top": {
			dirDesc.paths = [ [ "command/" ], [ "permission/" ] ];
			dirDesc.spec = {
				...spec,
				createFiles: false
			}
			break;
		}
		case "command":
		case "permission": {
			dirDesc.paths = [
				[ "global/" ],
				...(config.guildIds || []).map(id => [ id + "/" ] as PathInfo)
			];
			dirDesc.spec = {
				...spec,
				createFiles: false
			}
			break;
		}
		case "global":
		case "guild": {
			const reqPath = reqType === "global" ? "commands" : `guilds/${scopeEl}/commands`;
			const pathsReq = getRequest(reqPath, "GET", context.tenant, config);
			const pathsResp = await context.makeRequest(pathsReq);
			let pathsData: { id: string, name: string, version: string }[] = [];
			if (!pathsResp.ok) {
				console.log(`Discord API error: ${pathsResp.status} ${await pathsResp.data?.asString() || 'API error'}`);
			} else {
				pathsData = await pathsResp.data?.asJson() || [];
			}
			dirDesc.paths = pathsData.map(pd => [ commandSchema.pathPattern.replace("${name}", pd.name).replace("${id}", pd.id), snowflakeToTimestamp(pd.version) ]);
			dirDesc.spec = spec;
			break;
		}
	}

	msg.data = MessageBody.fromObject(dirDesc).setIsDirectory();
    return msg;
});

export default service;