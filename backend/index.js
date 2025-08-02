const dotenv = require("dotenv").config();
const express = require("express");
const cors = require("cors");


const audioRoutes = require("./routes/audioRoutes");
const meetingRoutes = require("./routes/meetingRoutes");

const app = express();

app.use(cors());
app.use(express.json());


app.use("/api/audios", audioRoutes);
app.use("/api/meeting/", meetingRoutes)
// app.use("/api/chat",);
// app.use("/api/transcription",);


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});