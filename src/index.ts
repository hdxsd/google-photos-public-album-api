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
	let queryAlbumUrl = url.searchParams.get('url');
	
	// Kalo query parameter cuma ID doang (format: 7QzAnueaCVnrQdiG7)
	if (queryAlbumUrl && !queryAlbumUrl.includes('http')) {
		queryAlbumUrl = `https://photos.app.goo.gl/${queryAlbumUrl}`;
	}
	
	// Fallback ke env variable kalo ga ada query parameter
	const albumUrl = queryAlbumUrl?.trim() || env.ALBUM_URL?.trim();

	if (!albumUrl) {
		return jsonResponse(
			{ 
				error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable',
				title: null,
				images: [],
				count: 0,
				albumUrl: null,
				fetchedAt: new Date().toISOString()
			}, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}

	try {
		// Fetch album page
		const resp = await fetch(`${albumUrl}?_imcp=1`, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});
		const text = await resp.text();

		// Extract album title from <title> tag
		let title = null;
		const titleMatch = text.match(/<title>(.+?)<\/title>/);
		if (titleMatch) {
			title = titleMatch[1].replace(' - Google Photos', '').trim();
		}

		// Regex untuk foto dan video
		const photoMatches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]+\][^\]]+\]\],(\d+),[^,]+,[^,]+,(\d+)/g
			),
		];
		
		const videoMatches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",.*?(?:video|mp4).*?\]/g
			),
		];

		// Process videos (prioritas utama kalo ada video)
		if (videoMatches.length > 0) {
			const videos = await Promise.all(videoMatches.map(async ([, baseUrl]) => {
				if (!baseUrl) return null;
				
				// Generate thumbnail (frame pertama)
				const thumbnail = `${baseUrl}=w1280-h720-no`;
				
				// Generate title dari URL atau default
				const videoTitle = title || 'Untitled Video';
				
				// Cek resolusi asli dari URL (kalo ada info dimensi)
				const resolutionMatch = text.match(new RegExp(baseUrl + '.*?(\\d+),(\\d+)'));
				const width = resolutionMatch ? parseInt(resolutionMatch[1]) : 1920;
				const height = resolutionMatch ? parseInt(resolutionMatch[2]) : 1080;
				
				// Tentukan resolusi berdasarkan tinggi
				let resolutions = [];
				if (height >= 1080) {
					resolutions = ['m37', 'm22', 'm18']; // 1080p, 720p, 360p
				} else if (height >= 720) {
					resolutions = ['m22', 'm18']; // 720p, 360p
				} else {
					resolutions = ['m18']; // 360p doang
				}
				
				// Buat sources
				const sources = resolutions.map(res => ({
					file: `${baseUrl}=${res}`,
					label: res === 'm37' ? '1080p' : res === 'm22' ? '720p' : '360p',
					type: 'video/mp4'
				}));
				
				return {
					title: videoTitle,
					status: true,
					sources,
					image: thumbnail,
					host: 'googlephotos',
					vtt: null
				};
			}));
			
			// Filter out null values
			const validVideos = videos.filter(v => v !== null);
			
			return jsonResponse(
				{ 
					title,
					images: validVideos,
					count: validVideos.length,
					albumUrl,
					fetchedAt: new Date().toISOString()
				},
				{
					status: 200,
					allowOrigin: env.ALLOW_ORIGIN,
					extraHeaders: { 
						'Cache-Control': env.CACHE_CONTROL || 'max-age=604800, stale-while-revalidate'
					},
				}
			);
		}

		// Kalo ga ada video, proses foto biasa
		const images = photoMatches.flatMap(([, url, width, height, createdTimestamp, updatedTimestamp]) => {
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
		
		// Format foto sesuai output yang diminta (tapi tetep pake struktur yg sama)
		const formattedImages = deduplicated.map(img => ({
			title: title || 'Untitled Photo',
			status: true,
			sources: [
				{
					file: img.url,
					label: `${img.height}p`,
					type: 'image/jpeg'
				}
			],
			image: img.url,
			host: 'googlephotos',
			vtt: null
		}));
		
		return jsonResponse(
			{ 
				title,
				images: formattedImages,
				count: formattedImages.length,
				albumUrl,
				fetchedAt: new Date().toISOString()
			},
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=604800, stale-while-revalidate'
				},
			}
		);

	} catch (error) {
		return jsonResponse(
			{ 
				error: error.message,
				title: null,
				images: [],
				count: 0,
				albumUrl,
				fetchedAt: new Date().toISOString()
			}, 
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
