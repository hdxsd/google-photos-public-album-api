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
	
	// Kalo ga ada parameter url, coba pake env variable
	if (!albumUrl) {
		albumUrl = env.ALBUM_URL?.trim();
	}

	if (!albumUrl) {
		return jsonResponse(
			[{ 
				title: 'Error',
				status: false,
				error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable'
			}], 
			{ status: 400, allowOrigin: env.ALLOW_ORIGIN }
		);
	}

	// Handle short URL (photos.app.goo.gl/xxxxx)
	if (!albumUrl.startsWith('http')) {
		// Kalo cuma kode pendek, ubah jadi full URL
		if (!albumUrl.includes('photos.app.goo.gl/')) {
			albumUrl = `https://photos.app.goo.gl/${albumUrl}`;
		}
	}

	try {
		// Fetch album page
		const resp = await fetch(albumUrl, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});
		
		if (!resp.ok) {
			throw new Error(`Failed to fetch album: ${resp.status}`);
		}
		
		const text = await resp.text();

		// Ambil judul album dari <title>
		const titleMatch = text.match(/<title>(.+?)<\/title>/);
		const albumTitle = titleMatch ? titleMatch[1].replace(/\s*-\s*Google\s*Photos\s*$/i, '').trim() : 'Untitled Album';

		// Regex buat detect video entries - pattern dari Google Photos
		const videoMatches = [
			...text.matchAll(
				/\[(\d+),\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+),.*?,(true|false),.*?,(true|false),(\d+),(\d+)\]/g
			),
		];

		const videos = videoMatches.map(match => {
			const [, id, baseUrl, width, height, isVideo, , , created, updated] = match;
			
			// Base URL tanpa parameter
			const cleanBaseUrl = baseUrl.split('=')[0];
			
			// Buat thumbnail dari frame pertama
			const thumbnail = `${cleanBaseUrl}=w1280-h720-no`;

			// Koleksi berbagai kualitas video
			const sources = [
				{
					file: `${cleanBaseUrl}=m37`, // 1080p
					label: '1080p',
					type: 'video/mp4'
				},
				{
					file: `${cleanBaseUrl}=m22`, // 720p
					label: '720p', 
					type: 'video/mp4'
				},
				{
					file: `${cleanBaseUrl}=m18`, // 360p
					label: '360p',
					type: 'video/mp4'
				}
			];

			// Cek kalo ada source 4K (m38)
			if (text.includes(`"${cleanBaseUrl}=m38"`)) {
				sources.unshift({
					file: `${cleanBaseUrl}=m38`,
					label: '4K',
					type: 'video/mp4'
				});
			}

			return {
				title: albumTitle,
				status: true,
				sources,
				image: thumbnail,
				host: 'googlephotos',
				vtt: null,
				id: Number(id),
				created: Number(created),
				updated: Number(updated)
			};
		});

		// Kalo ga ada video, coba cek pake regex alternatif
		if (videos.length === 0) {
			// Regex alternatif buat video
			const altMatches = [
				...text.matchAll(
					/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+),.*?(true),/g
				),
			];

			const altVideos = altMatches.map(([, baseUrl, width, height]) => {
				const cleanBaseUrl = baseUrl.split('=')[0];
				
				return {
					title: albumTitle,
					status: true,
					sources: [
						{
							file: `${cleanBaseUrl}=m37`,
							label: '1080p',
							type: 'video/mp4'
						},
						{
							file: `${cleanBaseUrl}=m22`,
							label: '720p',
							type: 'video/mp4'
						},
						{
							file: `${cleanBaseUrl}=m18`,
							label: '360p',
							type: 'video/mp4'
						}
					],
					image: `${cleanBaseUrl}=w1280-h720-no`,
					host: 'googlephotos',
					vtt: null
				};
			});

			// Hapus duplikat berdasarkan URL
			const uniqueVideos = [...new Map(altVideos.map(v => [v.sources[0].file, v])).values()];
			
			if (uniqueVideos.length > 0) {
				return jsonResponse(uniqueVideos, {
					status: 200,
					allowOrigin: env.ALLOW_ORIGIN,
					extraHeaders: { 
						'Cache-Control': env.CACHE_CONTROL || 'max-age=3600, stale-while-revalidate'
					},
				});
			}
		}

		// Hapus duplikat berdasarkan URL video
		const uniqueVideos = [...new Map(videos.map(v => [v.sources[0].file, v])).values()];

		// Kalo tetep ga ada video
		if (uniqueVideos.length === 0) {
			return jsonResponse(
				[{
					title: albumTitle,
					status: false,
					error: 'No videos found in this album'
				}],
				{ status: 404, allowOrigin: env.ALLOW_ORIGIN }
			);
		}

		return jsonResponse(uniqueVideos, {
			status: 200,
			allowOrigin: env.ALLOW_ORIGIN,
			extraHeaders: { 
				'Cache-Control': env.CACHE_CONTROL || 'max-age=3600, stale-while-revalidate'
			},
		});

	} catch (error: any) {
		return jsonResponse(
			[{
				title: 'Error',
				status: false,
				error: error.message
			}], 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data, null, 2), {
		status: params.status || 200,
		headers: { 
			'content-type': 'application/json;charset=UTF-8', 
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
