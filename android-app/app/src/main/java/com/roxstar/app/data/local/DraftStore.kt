package com.roxstar.app.data.local

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow
import java.io.File

/**
 * Local draft metadata.
 *
 * Drafts live on the device (D10). This table is the index over the WAV files
 * in filesDir/recordings -- it holds name, duration, effect and creation time
 * so the list can be rendered without opening every file to read its header.
 *
 * The audio itself is never uploaded. Sharing a draft sends this metadata and
 * nothing else.
 */
@Entity(tableName = "drafts")
data class DraftEntity(
    @PrimaryKey val draftId: String,
    val name: String,
    val filePath: String,
    val durationMs: Long,
    val effect: String,
    val createdAt: Long,
    /** Set once the draft has been shared with a room, for the UI badge. */
    val sharedAt: Long? = null,
) {
    val file: File get() = File(filePath)
    /** The file can be deleted out from under us by the OS clearing app data. */
    val exists: Boolean get() = file.exists()
}

@Dao
interface DraftDao {
    @Query("SELECT * FROM drafts ORDER BY createdAt DESC")
    fun observeAll(): Flow<List<DraftEntity>>

    @Query("SELECT * FROM drafts WHERE draftId = :id")
    suspend fun findById(id: String): DraftEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(draft: DraftEntity)

    @Query("UPDATE drafts SET sharedAt = :sharedAt WHERE draftId = :id")
    suspend fun markShared(id: String, sharedAt: Long)

    @Query("DELETE FROM drafts WHERE draftId = :id")
    suspend fun delete(id: String)

    @Query("SELECT * FROM drafts")
    suspend fun all(): List<DraftEntity>
}

@Database(entities = [DraftEntity::class], version = 1, exportSchema = false)
abstract class RoxstarDatabase : RoomDatabase() {
    abstract fun draftDao(): DraftDao

    companion object {
        @Volatile
        private var instance: RoxstarDatabase? = null

        fun get(context: Context): RoxstarDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    RoxstarDatabase::class.java,
                    "roxstar.db",
                )
                    // Acceptable here and only here: this table is a cache over
                    // local files, so losing it on a schema change costs the
                    // user nothing that cannot be re-derived. The server-side
                    // schema uses real migrations.
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { instance = it }
            }
    }
}
