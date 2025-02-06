import { NextRequest, NextResponse } from "next/server"
import { bucket } from "@/lib/google-cloud-storage"
import { prisma } from "@/lib/prisma"
import { getServerSession } from "next-auth/next"
import { authOptions } from "@/lib/auth-options"
import { v4 as uuidv4 } from 'uuid'

const STORAGE_LIMIT_MB = 100 // 100MB em megabytes

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    console.log("Iniciando busca de arquivos")
    const session = await getServerSession(authOptions)
    console.log("Sessão:", session)
    if (!session?.user) {
      return new NextResponse("Não autorizado", { status: 401 })
    }

    const searchParams = new URL(req.url).searchParams
    const limit = Number(searchParams.get("limit")) || undefined

    // Verificar se o restaurante pertence ao usuário
    const restaurant = await prisma.restaurant.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    })

    if (!restaurant) {
      return new NextResponse("Restaurante não encontrado", { status: 404 })
    }

    const files = await prisma.restaurantFile.findMany({
      where: {
        restaurantId: params.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
    })

    const usage = {
      files,
      totalSize: files.reduce((acc, file) => acc + file.size, 0),
      usedStorage: files.reduce((acc, file) => acc + (file.size / 1024 / 1024), 0),
      availableStorage: STORAGE_LIMIT_MB,
      percentageUsed: (files.reduce((acc, file) => acc + (file.size / 1024 / 1024), 0) / STORAGE_LIMIT_MB) * 100
    }

    return NextResponse.json(usage)
  } catch (error) {
    console.error("Erro detalhado ao buscar arquivos:", error)
    return new NextResponse(
      `Erro interno do servidor: ${error instanceof Error ? error.message : 'Erro desconhecido'}`, 
      { status: 500 }
    )
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return new NextResponse("Não autorizado", { status: 401 })
    }

    const restaurant = await prisma.restaurant.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    })

    if (!restaurant) {
      return new NextResponse("Restaurante não encontrado", { status: 404 })
    }

    // Calcular uso atual do usuário
    const userFiles = await prisma.restaurantFile.findMany({
      where: {
        restaurant: {
          userId: session.user.id
        }
      }
    })
    
    const currentUsageMB = userFiles.reduce((acc, file) => acc + (file.size / 1024 / 1024), 0)
    
    // Verificar o arquivo novo
    const formData = await req.formData()
    const file = formData.get("file") as File
    
    if (!file) {
      return new NextResponse("Nenhum arquivo enviado", { status: 400 })
    }

    const fileSizeMB = file.size / 1024 / 1024
    
    // Verificar se o novo arquivo excederá o limite
    if (currentUsageMB + fileSizeMB > STORAGE_LIMIT_MB) {
      return new NextResponse(
        `Limite de armazenamento excedido. Você tem ${STORAGE_LIMIT_MB - currentUsageMB}MB disponíveis.`, 
        { status: 400 }
      )
    }

    const fileBuffer = Buffer.from(await file.arrayBuffer())
    const fileName = `${restaurant.id}/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${uuidv4()}-${file.name}`
    
    const blob = bucket.file(`restaurants/${fileName}`)
    
    return new Promise((resolve, reject) => {
      const blobStream = blob.createWriteStream({
        resumable: false,
        metadata: {
          contentType: file.type,
        },
      })

      blobStream.on('error', async (err) => {
        console.error("Erro no upload:", err)
        try {
          await blob.delete()
        } catch (deleteError) {
          console.error("Erro ao limpar arquivo parcial:", deleteError)
        }
        reject(new NextResponse("Erro ao fazer upload do arquivo", { status: 500 }))
      })

      blobStream.on('finish', async () => {
        try {
          // Não precisa mais chamar makePublic() pois o bucket já está público
          const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`

          const fileRecord = await prisma.restaurantFile.create({
            data: {
              name: file.name,
              size: file.size,
              type: file.type,
              url: publicUrl,
              restaurantId: restaurant.id,
            },
          })

          resolve(NextResponse.json(fileRecord))
        } catch (error) {
          console.error("Erro ao salvar arquivo:", error)
          try {
            await blob.delete()
          } catch (deleteError) {
            console.error("Erro ao limpar arquivo após falha:", deleteError)
          }
          reject(new NextResponse("Erro ao salvar arquivo", { status: 500 }))
        }
      })

      blobStream.end(fileBuffer)
    })
  } catch (error) {
    console.error("Erro ao processar upload:", error)
    return new NextResponse("Erro interno do servidor", { status: 500 })
  }
} 