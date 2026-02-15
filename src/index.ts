/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Env {
	ALBUM_URL?: string;
	ALLOW_ORIGIN?: string;
	CACHE_CONTROL?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		switch (request.method) {
			case 'GET':
				return handleGet(request, env);
			case 'OPTIONS':
				return handleOptions(env);
			default:
				return new Response(null, { status: 405 });
		}
	},
};

const handleGet = async (request: Request, env: Env): Promise<Response> => {
	// Coba ambil dari query parameter dulu
	const url = new URL(request.url);
	let albumUrl = url.searchParams.get('url')?.trim();
	
	// Kalo ga ada parameter url, pake env variable
	if (!albumUrl) {
		albumUrl = env.ALBUM_URL?.trim();
	}
	
	// Handle kalo user masukin short code aja (7QzAnueaCVnrQdiG7)
	if (albumUrl && !albumUrl.startsWith('http')) {
		// Asumsinya ini short code dari photos.app.goo.gl
		albumUrl = `https://photos.app.goo.gl/${albumUrl}`;
	}

	if (!albumUrl) {
		return jsonResponse(
			{ error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable' }, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}

	try {
		// Fetch dengan follow redirect (short link bakal di-redirect ke URL panjang)
		const resp = await fetch(`${albumUrl}?_imcp=1`, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; Google-Photos-Worker/1.0)'
			}
		});
		
		if (!resp.ok) {
			return jsonResponse(
				{ error: `Failed to fetch album: ${resp.status}` }, 
				{ status: 502, allowOrigin: env.ALLOW_ORIGIN }
			);
		}
		
		const text = await resp.text();

		const matches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]+\][^\]]+\]\],(\d+),[^,]+,[^,]+,(\d+)/g,
			),
		];
		
		const images = matches.flatMap(([, url, width, height, createdTimestamp, updatedTimestamp]) => {
			if (!url || !width || !height) {
				return [];
			}

			return {
				url,
				width: Number(width),
				height: Number(height),
				createdTimestamp: Number(createdTimestamp),
				updatedTimestamp: Number(updatedTimestamp),
			};
		});

		const deduplicated = [...new Map(images.map((image) => [image.url, image])).values()];
		
		return jsonResponse(
			{ 
				images: deduplicated, 
				count: deduplicated.length,
				albumUrl: albumUrl // Kasih tau URL yang dipake
			},
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=604800, stale-while-revalidate' 
				},
			}
		);
	} catch (error: any) {
		return jsonResponse(
			{ error: `Failed to process album: ${error.message}` }, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data), {
		status: params.status || 200,
		headers: { 
			'content-type': 'application/json', 
			'Access-Control-Allow-Origin': params.allowOrigin || '*', 
			...params.extraHeaders 
		},
	});
};

const handleOptions = async (env: Env): Promise<Response> => {
	return new Response(null, {
		status: 204,
		headers: {
			Allow: 'GET, OPTIONS',
			'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Max-Age': '86400',
		},
	});
};
