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
				return new Response(null, { 
					status: 405,
					headers: {
						'Allow': 'GET, OPTIONS',
						'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
					}
				});
		}
	},
};

const handleGet = async (request: Request, env: Env): Promise<Response> => {
	try {
		// Ambil dari query parameter
		const url = new URL(request.url);
		let queryAlbumUrl = url.searchParams.get('url');
		
		// Kalo cuma ID doang (format pendek)
		if (queryAlbumUrl && !queryAlbumUrl.includes('http')) {
			queryAlbumUrl = `https://photos.app.goo.gl/${queryAlbumUrl}`;
		}
		
		const albumUrl = queryAlbumUrl?.trim() || env.ALBUM_URL?.trim();

		if (!albumUrl) {
			return jsonResponse(
				{ 
					error: 'ALBUM_URL not set',
					videos: [],
					count: 0
				}, 
				{ status: 400, allowOrigin: env.ALLOW_ORIGIN }
			);
		}

		// Fetch album page
		const resp = await fetch(albumUrl, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});

		if (!resp.ok) {
			throw new Error(`Failed to fetch: ${resp.status}`);
		}

		const html = await resp.text();

		// ========== REGEX KHUSUS VIDEO ==========
		// Pattern 1: Video dengan format array - YANG PALING UMUM
		const videoPattern1 = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_\/-]+)",(\d+),(\d+),?[^\]]*video[^\]]*\]/gi;
		
		// Pattern 2: Video dengan "mimeType":"video/mp4"
		const videoPattern2 = /"url":"(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_\/-]+)","width":(\d+),"height":(\d+)[^}]*"mimeType":"video\/mp4"/gi;
		
		// Pattern 3: Video dari data langsung (format Google Photos)
		const videoPattern3 = /\[(\d+),(\d+),\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_\/-]+)"\],\d+,\d+,\d+,\d+,\d+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,(\d+),(\d+),\[\d+\],\[(\d+),(\d+)\],\[\]/gi;

		const videos = new Map(); // Base URL sebagai key

		// Coba Pattern 1 dulu (paling sering muncul)
		const matches1 = html.matchAll(videoPattern1);
		for (const match of matches1) {
			const baseUrl = match[1];
			if (!baseUrl || videos.has(baseUrl)) continue;
			
			videos.set(baseUrl, {
				baseUrl,
				width: parseInt(match[2]) || 1920,
				height: parseInt(match[3]) || 1080
			});
		}

		// Pattern 2
		const matches2 = html.matchAll(videoPattern2);
		for (const match of matches2) {
			const baseUrl = match[1];
			if (!baseUrl || videos.has(baseUrl)) continue;
			
			videos.set(baseUrl, {
				baseUrl,
				width: parseInt(match[2]) || 1920,
				height: parseInt(match[3]) || 1080
			});
		}

		// Pattern 3
		const matches3 = html.matchAll(videoPattern3);
		for (const match of matches3) {
			const baseUrl = match[3];
			if (!baseUrl || videos.has(baseUrl)) continue;
			
			videos.set(baseUrl, {
				baseUrl,
				width: parseInt(match[12]) || 1920, // width ada di posisi 12
				height: parseInt(match[13]) || 1080 // height di posisi 13
			});
		}

		// ========== FALLBACK: Cari semua URL video ==========
		if (videos.size === 0) {
			// Ambil semua URL Google Photos dulu
			const urlRegex = /(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_\/-]+)/g;
			const allUrls = [...new Set(html.match(urlRegex) || [])];
			
			// Filter yang context-nya mengandung "video"
			for (const url of allUrls) {
				if (videos.has(url)) continue;
				
				// Cek 500 karakter sebelum dan sesudah URL
				const index = html.indexOf(url);
				const start = Math.max(0, index - 500);
				const end = Math.min(html.length, index + 500);
				const context = html.substring(start, end);
				
				if (context.includes('video') || context.includes('mp4')) {
					// Cari dimensi di context
					const dimMatch = context.match(/(\d+)[, ]+(\d+)/);
					videos.set(url, {
						baseUrl: url,
						width: dimMatch ? parseInt(dimMatch[1]) : 1920,
						height: dimMatch ? parseInt(dimMatch[2]) : 1080
					});
				}
			}
		}

		console.log(`Found ${videos.size} videos`);

		// Konversi ke format output
		const videoList = Array.from(videos.values()).map(video => {
			// Thumbnail
			const thumbnail = `${video.baseUrl}=w1280-h720-no`;
			
			// Resolusi berdasarkan tinggi
			const sources = [];
			if (video.height >= 1080) {
				sources.push(
					{ file: `${video.baseUrl}=m37`, label: '1080p', type: 'video/mp4' },
					{ file: `${video.baseUrl}=m22`, label: '720p', type: 'video/mp4' },
					{ file: `${video.baseUrl}=m18`, label: '360p', type: 'video/mp4' }
				);
			} else if (video.height >= 720) {
				sources.push(
					{ file: `${video.baseUrl}=m22`, label: '720p', type: 'video/mp4' },
					{ file: `${video.baseUrl}=m18`, label: '360p', type: 'video/mp4' }
				);
			} else {
				sources.push(
					{ file: `${video.baseUrl}=m18`, label: '360p', type: 'video/mp4' }
				);
			}
			
			return {
				status: true,
				sources,
				image: thumbnail,
				host: 'googlephotos',
				vtt: null,
				width: video.width,
				height: video.height
			};
		});

		return jsonResponse(
			{ 
				videos: videoList,
				count: videoList.length,
				albumUrl
			},
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=604800'
				},
			}
		);

	} catch (error) {
		return jsonResponse(
			{ 
				error: error.message,
				videos: [],
				count: 0
			}, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data, null, 2), {
		status: params.status || 200,
		headers: { 
			'Content-Type': 'application/json', 
			'Access-Control-Allow-Origin': params.allowOrigin || '*', 
			...params.extraHeaders 
		},
	});
};

const handleOptions = async (env: Env): Promise<Response> => {
	return new Response(null, {
		status: 204,
		headers: {
			'Allow': 'GET, OPTIONS',
			'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Max-Age': '86400',
		},
	});
};
