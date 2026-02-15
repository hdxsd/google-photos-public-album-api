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
	try {
		// Ambil album URL dari query parameter atau env
		const url = new URL(request.url);
		let albumUrl = url.searchParams.get('url')?.trim() || env.ALBUM_URL?.trim();
		
		// Handle short URL format (kalo cuma ID doang)
		if (albumUrl && !albumUrl.startsWith('http')) {
			albumUrl = `https://photos.app.goo.gl/${albumUrl}`;
		}

		if (!albumUrl) {
			return jsonResponse(
				{ error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable' }, 
				{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
			);
		}

		// Fetch album dengan follow redirect
		const resp = await fetch(`${albumUrl}?_imcp=1`, { 
			redirect: 'follow',
			headers: { 'User-Agent': 'Mozilla/5.0' }
		});
		
		const text = await resp.text();

		// Ambil title album dari <title> tag
		const titleMatch = text.match(/<title>(.+?)<\/title>/);
		let title = titleMatch ? titleMatch[1].replace(/\s*-\s*Google\s*Photos\s*$/i, '').trim() : 'Untitled Album';

		// Regex untuk ambil video dari Google Photos
		const videoMatches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[^"]+)",(\d+),(\d+)[^\]]+\](?:[^\[]*\[[^\]]*\]){2,}\]\],(\d+),(\d+),(\d+),(\d+),(\d+)/g
			),
		];

		// Regex untuk ambil thumbnail
		const thumbnailMatches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[^"]+)",(\d+),(\d+)\]/g
			),
		];

		// Map untuk thumbnail
		const thumbnailMap = new Map();
		thumbnailMatches.forEach(([, thumbUrl, width, height]) => {
			if (thumbUrl && !thumbnailMap.has(thumbUrl)) {
				thumbnailMap.set(thumbUrl, { width: Number(width), height: Number(height) });
			}
		});

		// Proses video
		const videos = [];
		const seenUrls = new Set();

		for (const match of videoMatches) {
			const [, baseUrl, width, height, ...timestamps] = match;
			
			if (!baseUrl || seenUrls.has(baseUrl)) continue;
			
			// Ambil timestamp terakhir sebagai updated
			const validTimestamps = timestamps.filter(t => t && !isNaN(Number(t))).map(Number);
			const updatedTimestamp = validTimestamps.length > 0 ? Math.max(...validTimestamps) : Date.now();
			
			// Cari thumbnail yang cocok
			let thumbnail = null;
			let thumbDimensions = { width: 1280, height: 720 }; // default
			
			for (const [thumbUrl, dims] of thumbnailMap) {
				if (thumbUrl.includes(baseUrl.split('/pw/')[1]?.split('=')[0])) {
					thumbnail = thumbUrl;
					thumbDimensions = dims;
					break;
				}
			}
			
			if (!thumbnail) {
				// Fallback: generate thumbnail dari base URL
				thumbnail = `${baseUrl}=w${thumbDimensions.width}-h${thumbDimensions.height}-no`;
			}

			// Resolusi yang tersedia
			const resolutions = [
				{ label: '1080p', suffix: 'm37', width: 1920, height: 1080 },
				{ label: '720p', suffix: 'm22', width: 1280, height: 720 },
				{ label: '360p', suffix: 'm18', width: 640, height: 360 }
			];

			const sources = resolutions.map(res => ({
				file: `${baseUrl}=${res.suffix}`,
				label: res.label,
				type: 'video/mp4'
			}));

			videos.push({
				title: title,
				status: true,
				sources: sources,
				image: `${thumbnail}=w${thumbDimensions.width}-h${thumbDimensions.height}-no`,
				host: 'googlephotos',
				vtt: null
			});

			seenUrls.add(baseUrl);
		}

		const result = {
			title: title,
			images: [], // kosong karena kita fokus ke video
			count: videos.length,
			albumUrl: albumUrl,
			fetchedAt: new Date().toISOString(),
			videos: videos // tambahin array videos
		};

		return jsonResponse(
			result,
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=3600, stale-while-revalidate'
				},
			}
		);

	} catch (error) {
		return jsonResponse(
			{ error: 'Failed to fetch album', details: error.message },
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data, null, 2), {
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
